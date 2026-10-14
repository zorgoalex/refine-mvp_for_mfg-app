#!/usr/bin/env python3
"""Access groups 0Б: build Hasura metadata in which every permission requires the user's effective permission.

Rules: ops/hasura/access-predicates.json. Two steps (plan report 2026-10-13, section 5):
  A — additive: track user_effective_permissions / user_effective_scopes, add relationships, create the permissions of
      the admin role (erp_admin) with predicates. No existing role changes.
  B — every other role: wrap each permission in its predicate, drop revoked permissions. Fails on a permission that is
      neither in the rules nor an explicit exception.
Both steps are pure functions of (metadata, rules) and idempotent: a second build returns the same metadata.

CLI (used by access-predicates.sh and tests):
  access_predicates.py build --step A|B --rules RULES.json < metadata.json > new-metadata.json
  access_predicates.py status --rules RULES.json < metadata.json       → prints "A=applied|missing B=applied|missing"
Input may be export_metadata v1 (metadata object) or v2 ({resource_version, metadata}); output is the metadata object.
"""
import argparse
import copy
import json
import sys

SESSION_USER = "X-Hasura-User-Id"
OPS = ("select", "insert", "update", "delete")
VIEW_PERMS = "user_effective_permissions"
VIEW_SCOPES = "user_effective_scopes"


class RuleError(Exception):
    pass


class UnknownStateError(RuleError):
    """The outcome of a metadata replace is unknown (no answer and no re-read): keep every piece of state."""


# ---------------------------------------------------------------- predicate building blocks

def _table(name):
    return {"schema": "public", "name": name}


def perm_exists(permission):
    return {"_exists": {"_table": _table(VIEW_PERMS), "_where": {"_and": [
        {"user_id": {"_eq": SESSION_USER}}, {"permission_name": {"_eq": permission}}]}}}


def scope_exists(key, values):
    return {"_exists": {"_table": _table(VIEW_SCOPES), "_where": {"_and": [
        {"user_id": {"_eq": SESSION_USER}}, {"scope_key": {"_eq": key}}, {"scope_value": {"_in": list(values)}}]}}}


def nest(path, expr):
    """Put expr under a relationship path ('' = the row itself; 'a.b' = nested relationships)."""
    for name in reversed([part for part in path.split(".") if part]):
        expr = {name: expr}
    return expr


def owns():
    # Same as the backend «own» order rule: author or responsible manager (order-read-scope-sql.ts).
    return {"_or": [{"created_by": {"_eq": SESSION_USER}}, {"manager_id": {"_eq": SESSION_USER}}]}


ORDER_MODES = {
    # read: orderReadVisibilityIsRestricted — `assigned` does not narrow reads.
    "read": ("orders.view", "orders.view", ["all", "assigned"]),
    # update: order-access.policy canUpdateOrder — `assigned` needs an assignment Hasura cannot see → nothing.
    "update": ("orders.update", "orders.update", ["all"]),
}


def order_access(mode, path):
    permission, key, unrestricted = ORDER_MODES[mode]
    return {"_and": [perm_exists(permission), {"_or": [
        scope_exists(key, unrestricted),
        {"_and": [scope_exists(key, ["own"]), nest(path, owns())]},
    ]}]}


def active_links(extra=None):
    cond = [{"delete_flag": {"_eq": False}}]
    if extra is not None:
        cond.append(extra)
    return {"order_links": {"_and": cond} if len(cond) > 1 else cond[0]}


def doweling_orders_access(mode, prefix=""):
    """A doweling order is reachable when its own order (order_id) and every order it is linked to are."""
    permission, key, unrestricted = ORDER_MODES[mode]
    order_ok = {"_or": [nest(prefix, {"order_id": {"_is_null": True}}), order_access(mode, (prefix + ".order").strip("."))]}
    links_ok = {"_or": [
        {"_not": nest(prefix, active_links())},
        {"_and": [perm_exists(permission), {"_or": [
            scope_exists(key, unrestricted),
            # A forbidden link is one whose order is NOT owned. The negation stays outside the relationship: SQL
            # «NOT (created_by = me OR manager_id = me)» is UNKNOWN for a NULL manager_id and would hide the link.
            {"_and": [scope_exists(key, ["own"]),
                      {"_not": nest(prefix, active_links({"_not": {"order": owns()}}))}]},
        ]}]},
    ]}
    return {"_and": [order_ok, links_ok]}


def rule_predicate(rule):
    parts = []
    if rule.get("any"):
        anys = [perm_exists(p) for p in rule["any"]]
        parts.append(anys[0] if len(anys) == 1 else {"_or": anys})
    for permission in rule.get("all", []):
        parts.append(perm_exists(permission))
    for key in rule.get("scopeAll", []):
        parts.append(scope_exists(key, ["all"]))
    if "orderRead" in rule:
        parts.append(order_access("read", rule["orderRead"]))
    if "orderUpdate" in rule:
        parts.append(order_access("update", rule["orderUpdate"]))
    doweling = rule.get("doweling")
    if doweling == "read":
        parts.append(doweling_orders_access("read"))
    elif doweling == "insert":
        parts.append({"_or": [{"order_id": {"_is_null": True}}, order_access("update", "order")]})
    elif doweling == "write":
        parts.append(doweling_orders_access("update"))
    elif doweling is not None:
        raise RuleError(f"unknown doweling mode {doweling!r}")
    if "dowelingVia" in rule:
        parts.append(doweling_orders_access("update", rule["dowelingVia"]))
    if "dowelingRead" in rule:
        # The view takes order_id from active links only; check the doweling order itself (own order_id + all links).
        parts.append(doweling_orders_access("read", rule["dowelingRead"]))
    if not parts:
        raise RuleError(f"rule without a condition: {rule!r}")
    return parts[0] if len(parts) == 1 else {"_and": parts}


def wrap(base, predicate):
    base = base if base is not None else {}
    if is_wrapped(base, predicate):
        return base
    return {"_and": [base, predicate]}


def is_wrapped(expr, predicate):
    return isinstance(expr, dict) and list(expr) == ["_and"] and len(expr["_and"]) == 2 and expr["_and"][1] == predicate


BOOL_KEYS = {"select": ("filter",), "insert": ("check",), "update": ("filter", "check"), "delete": ("filter",)}


# ---------------------------------------------------------------- metadata helpers

def unwrap_export(raw):
    if isinstance(raw, dict) and "metadata" in raw and "resource_version" in raw:
        return raw["metadata"]
    return raw


def source_tables(metadata):
    sources = metadata.get("sources") or []
    if len(sources) != 1:
        raise RuleError(f"expected exactly one source, found {len(sources)}")
    return sources[0].setdefault("tables", [])


def find_table(tables, name):
    for entry in tables:
        ref = entry.get("table", {})
        if ref.get("name") == name and ref.get("schema", "public") == "public":
            return entry
    return None


def rule_for(rules, table, op):
    return (rules.get("tables", {}).get(table) or {}).get(op)


def revoked(rules, table, op):
    return op in (rules.get("revoke", {}).get(table) or [])


def exception(rules, table, op):
    return f"{table}.{op}" in rules.get("exceptions", {})


def permission_with_predicate(op, permission, predicate):
    result = copy.deepcopy(permission)
    for key in BOOL_KEYS[op]:
        if op == "update" and key == "check" and "check" not in result:
            result["check"] = {}
        result[key] = wrap(result.get(key), predicate)
    return result


def relationship_entry(rel):
    return {"name": rel["name"], "using": {"manual_configuration": {
        # Hasura exports manual relationships (object and array) with insertion_order: null.
        "remote_table": _table(rel["remoteTable"]), "column_mapping": dict(rel["columnMapping"]), "insertion_order": None,
    }}}


# ---------------------------------------------------------------- steps

def build_step_a(metadata, rules):
    metadata = copy.deepcopy(unwrap_export(metadata))
    tables = source_tables(metadata)
    admin = rules["adminRole"]
    template = rules["adminTemplateRole"]

    for name in rules.get("trackTables", []):
        if find_table(tables, name) is None:
            tables.append({"table": _table(name)})

    for rel in rules.get("relationships", []):
        entry = find_table(tables, rel["table"])
        if entry is None:
            raise RuleError(f"relationship on untracked table {rel['table']}")
        key = "object_relationships" if rel["type"] == "object" else "array_relationships"
        wanted = relationship_entry(rel)
        existing = entry.setdefault(key, [])
        other = [r for r in existing if r["name"] == rel["name"]]
        if other and other[0] != wanted:
            raise RuleError(f"{rel['table']}.{rel['name']} exists with another definition")
        if not other:
            existing.append(wanted)

    for entry in tables:
        name = entry["table"]["name"]
        for op in OPS:
            key = f"{op}_permissions"
            perms = entry.get(key) or []
            source = next((p for p in perms if p["role"] == template), None)
            extra = (rules.get("adminExtra", {}).get(name) or {}).get(op)
            perms = [p for p in perms if p["role"] != admin]
            base = None
            if extra is not None:
                base = {k: copy.deepcopy(v) for k, v in extra.items()}
                for bool_key in BOOL_KEYS[op]:
                    base.setdefault(bool_key, {})
                if op != "delete":
                    base.setdefault("columns", [])
            elif source is not None and not revoked(rules, name, op):
                base = copy.deepcopy(source["permission"])
            if base is not None:
                rule = rule_for(rules, name, op)
                if rule is not None:
                    base = permission_with_predicate(op, base, rule_predicate(rule))
                elif not exception(rules, name, op):
                    raise RuleError(f"no rule for {name}.{op} (admin role)")
                perms.append({"role": admin, "permission": base})
            if perms:
                entry[key] = perms
            elif key in entry:
                del entry[key]
    return metadata


def build_step_b(metadata, rules):
    metadata = copy.deepcopy(unwrap_export(metadata))
    tables = source_tables(metadata)
    admin = rules["adminRole"]
    unmapped = []
    for entry in tables:
        name = entry["table"]["name"]
        for op in OPS:
            key = f"{op}_permissions"
            perms = entry.get(key)
            if not perms:
                continue
            kept = []
            for perm in perms:
                if perm["role"] == admin:
                    kept.append(perm)
                    continue
                if revoked(rules, name, op):
                    continue
                rule = rule_for(rules, name, op)
                if rule is not None:
                    kept.append({**perm, "permission": permission_with_predicate(op, perm["permission"], rule_predicate(rule))})
                elif exception(rules, name, op):
                    kept.append(perm)
                else:
                    unmapped.append(f"{name}.{op}/{perm['role']}")
                    kept.append(perm)
            if kept:
                entry[key] = kept
            else:
                del entry[key]
    if unmapped:
        raise RuleError("permissions without a rule: " + ", ".join(sorted(unmapped)))
    return metadata


def _normalized(metadata):
    """Order-insensitive view of metadata lists that Hasura may reorder on export."""
    metadata = copy.deepcopy(metadata)
    for source in metadata.get("sources", []):
        tables = source.get("tables", [])
        for entry in tables:
            for op in OPS:
                key = f"{op}_permissions"
                if key in entry:
                    entry[key] = sorted(entry[key], key=lambda p: p["role"])
                    # Not semantic: the order of a column list and an empty comment (lost when a script recreates it).
                    for perm in entry[key]:
                        if perm.get("comment") == "":
                            del perm["comment"]
                        if isinstance(perm.get("permission", {}).get("columns"), list):
                            perm["permission"]["columns"] = sorted(perm["permission"]["columns"])
            for key in ("object_relationships", "array_relationships"):
                if key in entry:
                    entry[key] = sorted(entry[key], key=lambda r: r["name"])
        source["tables"] = sorted(tables, key=lambda t: (t["table"].get("schema", "public"), t["table"]["name"]))
    return metadata


def _canonical(value):
    return json.dumps(_normalized(value), sort_keys=True)


def same_metadata(left, right):
    return _canonical(unwrap_export(left)) == _canonical(unwrap_export(right))


def status(metadata, rules):
    metadata = unwrap_export(metadata)
    a = same_metadata(build_step_a(metadata, rules), metadata)
    try:
        b = a and same_metadata(build_step_b(metadata, rules), metadata)
    except RuleError:
        b = False
    return {"A": "applied" if a else "missing", "B": "applied" if b else "missing"}


# ---------------------------------------------------------------- live Hasura (apply / revert / status)
#
# Safety of the live steps (code review R1):
# - apply checks the result against the approved snapshot of the release (--expect, the repo's metadata.json):
#   unknown drift of the live metadata (extra columns, roles, filters) is refused instead of being carried over;
# - permissions_state.hasura_access_predicates (migration 253) says whether Hasura follows the effective permissions.
#   While it is false the backend refuses every narrowing of the roles matrix. Step B sets it (with a snapshot of the
#   matrix, in one transaction that locks permissions_state like the matrix commands); revert clears it FIRST, then
#   compares the matrix with the snapshot, so no narrowing can slip between the check and the revert;
# - the state directory is locked (flock) for the whole command; a run writes a pending generation and only a
#   confirmed change becomes <step>-current, so a failed or concurrent run never replaces the evidence of a good one.

MATRIX_SQL = (
    "SELECT 'p|' || r.role_code || '|' || rp.permission_name FROM public.role_permissions rp "
    "JOIN public.roles r USING (role_id) JOIN public.permissions_catalog pc ON pc.permission_name = rp.permission_name "
    "WHERE rp.is_enabled AND pc.is_active "
    "UNION ALL SELECT 's|' || r.role_code || '|' || rps.scope_key || '=' || rps.scope_value FROM public.role_policy_scopes rps "
    "JOIN public.roles r USING (role_id) WHERE rps.scope_value <> 'none'"
)


def _jsonb(value):
    text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    if "$ag0b$" in text:
        raise RuleError("audit metadata must not contain the quote marker")
    return f"$ag0b${text}$ag0b$::jsonb"


def _quote(text):
    return "'" + str(text).replace("'", "''") + "'"


def audit_sql(event, run, details):
    """One audit row of an ops run: actor = the operator account (no ERP user), request = the run id. Idempotent per
    (event, run id, result): a resumed run completes the audit of the run that started the operation exactly once."""
    metadata = {"correlationId": run["runId"], "operator": run["operator"], **details}
    return (
        "INSERT INTO public.audit_log (event, entity_type, entity_id, username, request_id, source, after_json, metadata_json) "
        f"SELECT {_quote(event)}, 'hasura_metadata', {_quote(details.get('step', 'B'))}, {_quote('ops:' + run['operator'])}, "
        f"{_quote(run['runId'])}, 'ops', {_jsonb({'result': details.get('result')})}, {_jsonb(metadata)} "
        f"WHERE NOT EXISTS (SELECT 1 FROM public.audit_log WHERE event = {_quote(event)} AND request_id = {_quote(run['runId'])} "
        f"AND after_json ->> 'result' = {_quote(details.get('result'))}); "
    )


def flag_sql(value, run, details):
    """Lock permissions_state (lock order of the matrix commands), audit, set the flag, return the role matrix."""
    state = "true" if value else "false"
    metadata = {"correlationId": run["runId"], "operator": run["operator"], **details}
    return (
        "SELECT version FROM public.permissions_state WHERE id = true FOR UPDATE; "
        "INSERT INTO public.audit_log (event, entity_type, entity_id, username, request_id, source, before_json, after_json, diff_json, metadata_json) "
        "SELECT 'permissions.hasura_access_predicates.update', 'permissions_state', 'hasura_access_predicates', "
        f"{_quote('ops:' + run['operator'])}, {_quote(run['runId'])}, 'ops', "
        "jsonb_build_object('hasuraAccessPredicates', hasura_access_predicates), "
        f"jsonb_build_object('hasuraAccessPredicates', {state}), "
        f"jsonb_build_object('hasuraAccessPredicates', jsonb_build_object('from', hasura_access_predicates, 'to', {state})), "
        f"{_jsonb(metadata)} "
        f"FROM public.permissions_state WHERE id = true AND hasura_access_predicates IS DISTINCT FROM {state}; "
        f"UPDATE public.permissions_state SET hasura_access_predicates = {state}, updated_at = now() WHERE id = true; "
        + MATRIX_SQL
    )


class HasuraError(Exception):
    def __init__(self, status_code, body):
        super().__init__(f"HTTP {status_code}: {body[:300]}")
        self.status_code = status_code


class Hasura:
    def __init__(self, base_url, secret):
        self.base_url = base_url.rstrip("/")
        self.secret = secret

    def _post(self, path, payload):
        import urllib.error
        import urllib.request
        request = urllib.request.Request(
            self.base_url + path, data=json.dumps(payload).encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json", "x-hasura-admin-secret": self.secret})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise HasuraError(error.code, error.read().decode("utf-8", "replace")) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            raise HasuraError(0, f"no answer: {error}") from None

    def export(self):
        exported = self._post("/v1/metadata", {"type": "export_metadata", "version": 2, "args": {}})
        if not isinstance(exported.get("resource_version"), int) or not isinstance(exported.get("metadata"), dict):
            raise RuleError("export_metadata v2 did not return resource_version + metadata")
        return exported["resource_version"], exported["metadata"]

    def replace(self, resource_version, metadata):
        return self._post("/v1/metadata", {"type": "replace_metadata", "version": 2, "resource_version": resource_version,
                                           "args": {"allow_inconsistent_metadata": False, "metadata": metadata}})

    def _rows(self, sql, read_only):
        result = self._post("/v2/query", {"type": "run_sql", "args": {"source": "default", "sql": sql, "read_only": read_only}})
        return [row[0] for row in (result.get("result") or [])[1:]]

    def matrix(self):
        return sorted(self._rows(MATRIX_SQL, True))

    def flag(self):
        rows = self._rows("SELECT hasura_access_predicates::text FROM public.permissions_state WHERE id = true", True)
        return rows == ["true"]

    def set_flag(self, value, run, details):
        """Sets the flag under the permissions_state lock and returns the role matrix of that same transaction."""
        return sorted(self._rows(flag_sql(value, run, details), False))

    def audit(self, event, run, details):
        self._rows(audit_sql(event, run, details) + "SELECT 'ok'", False)


def _write_json(path, value):
    import os
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(value, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def _read_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


class StateDir:
    """Locked state directory with generations: <step>-<stamp>.pending → <step>-current (previous → .superseded)."""

    def __init__(self, path):
        import os
        self.path = path
        os.makedirs(path, exist_ok=True)

    def __enter__(self):
        import fcntl
        import os
        self.lock = open(os.path.join(self.path, ".lock"), "w")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuleError(f"another access-predicates command holds {self.path}") from None
        return self

    def __exit__(self, *exc):
        self.lock.close()

    def _stamp(self):
        import os
        import time
        return f"{time.strftime('%Y%m%dT%H%M%S')}-{os.getpid()}"

    def pending(self, step):
        import os
        path = os.path.join(self.path, f"{step}-{self._stamp()}.pending")
        os.makedirs(path)
        return path

    def pendings(self, step):
        import os
        return sorted(os.path.join(self.path, name) for name in os.listdir(self.path)
                      if name.startswith(f"{step}-") and name.endswith(".pending"))

    def current(self, step):
        import os
        return os.path.join(self.path, f"{step}-current")

    def confirm(self, step, pending):
        import os
        current = self.current(step)
        if os.path.isdir(current):
            os.rename(current, os.path.join(self.path, f"{step}-{self._stamp()}.superseded"))
        os.rename(pending, current)

    def retire(self, step, suffix):
        import os
        if os.path.isdir(self.current(step)):
            os.rename(self.current(step), os.path.join(self.path, f"{step}-{self._stamp()}.{suffix}"))

    @staticmethod
    def discard(pending):
        import shutil
        shutil.rmtree(pending, ignore_errors=True)


def lost_grants(at_b, now):
    """Grants of the snapshot missing now; a scope value replaced by `all` for the same role and key is not a loss."""
    now = set(now)
    lost = []
    for grant in sorted(set(at_b) - now):
        kind, role, rest = grant.split("|", 2)
        if kind == "s" and f"s|{role}|{rest.split('=')[0]}=all" in now:
            continue
        lost.append(grant)
    return lost


def _replace_confirmed(hasura, resource_version, metadata, previous):
    """replace_metadata; on any failure re-read the metadata: True if it is now `metadata` (the answer was lost),
    raises if it is still `previous`, raises 'unknown state' otherwise."""
    try:
        hasura.replace(resource_version, metadata)
        return True
    except HasuraError as error:
        try:
            now = hasura.export()[1]
        except HasuraError:
            raise UnknownStateError(f"replace_metadata failed ({error}) and the metadata cannot be re-read: state unknown; "
                                    "the state directory is kept — re-run the same command once Hasura answers") from None
        if same_metadata(now, metadata):
            return True
        if same_metadata(now, previous):
            if error.status_code == 409:
                raise RuleError("Hasura metadata changed after it was read (409 conflict); nothing changed. Re-run.") from None
            raise RuleError(f"replace_metadata failed, nothing changed: {error}") from None
        raise UnknownStateError(f"replace_metadata failed ({error}) and the metadata is neither before nor after: state unknown") from None


def _finish_b(hasura, state, generation, run, log):
    """After the metadata of B is confirmed: durable matrix snapshot FIRST (the flag is still false, so the backend
    refuses every narrowing and the snapshot cannot be overtaken), then the flag, then the confirmed generation."""
    import os
    matrix_file = os.path.join(generation, "matrix-at-B.json")
    if not os.path.exists(matrix_file):
        if hasura.flag():
            # Narrowings may already have happened: a snapshot taken now would hide them from the revert check.
            raise RuleError(f"{generation} has no matrix snapshot while the flag is already true: the rollback baseline "
                            "cannot be reconstructed; keep the confirmed generation or revert only with --allow-reopen")
        _write_json(matrix_file, hasura.matrix())
    origin = _read_json(os.path.join(generation, "intent.json"))["run"] if os.path.exists(os.path.join(generation, "intent.json")) else run
    if not hasura.flag():
        hasura.set_flag(True, run, {"operation": "apply-B", "step": "B", "generation": os.path.basename(generation), "originRunId": origin["runId"]})
    hasura.audit("permissions.hasura_access_predicates.step", origin, {"step": "B", "result": "applied", "generation": os.path.basename(generation)})
    if generation != state.current("B"):
        state.confirm("B", generation)


def cmd_apply(hasura, rules, step, state_dir, expect_path, dry_run, run, log):
    import os
    expected = _read_json(expect_path)
    with StateDir(state_dir) as state:
        resource_version, current = hasura.export()
        if step == "B" and status(current, rules)["A"] != "applied":
            raise RuleError("step A is not applied; run --step A first")
        built = (build_step_a if step == "A" else build_step_b)(current, rules)
        final = build_step_b(built, rules) if step == "A" else built
        if not same_metadata(final, expected):
            raise RuleError("the live metadata does not lead to the approved snapshot (--expect): unknown drift; nothing applied")
        applied = same_metadata(built, current)
        if dry_run:
            flag = hasura.flag() if step == "B" else None
            log(f"Dry run: step {step} metadata {'already applied' if applied else 'would change'}"
                + (f"; flag={'true' if flag else 'false'}" if step == "B" else "") + ". Nothing changed.")
            return 0
        if applied:
            # A confirmed generation of the live metadata wins (it holds the original matrix snapshot); otherwise resume
            # the newest pending generation whose «after» is the live metadata. Every other pending one is stale.
            confirmed = state.current(step)
            if os.path.isdir(confirmed) and same_metadata(_read_json(os.path.join(confirmed, "after.json")), current):
                generation = confirmed
            else:
                resumable = [g for g in state.pendings(step) if same_metadata(_read_json(os.path.join(g, "after.json")), current)]
                generation = resumable[-1] if resumable else None
            if generation is None:
                raise RuleError(f"step {step} is present but {state_dir} has no generation for it: rollback evidence is missing")
            for stale in state.pendings(step):
                if stale != generation:
                    state.discard(stale)
            if step == "B":
                _finish_b(hasura, state, generation, run, log)
            elif generation != state.current(step):
                intent_file = os.path.join(generation, "intent.json")
                origin = _read_json(intent_file)["run"] if os.path.exists(intent_file) else run
                hasura.audit("permissions.hasura_access_predicates.step", origin, {"step": "A", "result": "applied", "generation": os.path.basename(generation)})
                state.confirm(step, generation)
            log(f"Step {step}: already applied; state in {state.current(step)}.")
            return 0
        # The live metadata is not the step's result, so every pending generation of this step never took effect.
        for stale in state.pendings(step):
            state.discard(stale)
        pending = state.pending(step)
        _write_json(os.path.join(pending, "before.json"), current)
        _write_json(os.path.join(pending, "after.json"), built)
        _write_json(os.path.join(pending, "intent.json"), {"run": run, "operation": f"apply-{step}"})
        try:
            _replace_confirmed(hasura, resource_version, built, current)
        except UnknownStateError:
            raise  # the pending generation stays: a re-run resumes it once the outcome is known
        except RuleError:
            state.discard(pending)  # confirmed: nothing was applied
            raise
        if step == "B":
            _finish_b(hasura, state, pending, run, log)
        else:
            hasura.audit("permissions.hasura_access_predicates.step", run, {"step": "A", "result": "applied", "generation": os.path.basename(pending)})
            state.confirm(step, pending)
        log(f"Step {step} applied; state saved in {state.current(step)}.")
        return 0


def cmd_revert(hasura, step, state_dir, allow_reopen, run, log):
    import os
    if step != "B":
        raise RuleError("only step B can be reverted (step A is additive and the admin role depends on it)")
    with StateDir(state_dir) as state:
        current_dir = state.current("B")
        if not os.path.isdir(current_dir):
            raise RuleError(f"no confirmed step B in {state_dir}")
        generation = os.path.basename(current_dir)
        resource_version, current = hasura.export()
        before = _read_json(os.path.join(current_dir, "before.json"))
        after = _read_json(os.path.join(current_dir, "after.json"))
        intent_file = os.path.join(current_dir, "revert-intent.json")
        if same_metadata(current, before):
            # An earlier revert replaced the metadata but did not finish: Hasura is open, the flag must be false, and the
            # completion audit of that revert (its run, override and reopened grants) is written now if it is missing.
            if hasura.flag():
                hasura.set_flag(False, run, {"operation": "revert-B-recover", "step": "B", "generation": generation})
            if os.path.exists(intent_file):
                intent = _read_json(intent_file)
                hasura.audit("permissions.hasura_access_predicates.step", intent["run"], {
                    "step": "B", "result": "reverted", "generation": generation,
                    "allowReopen": intent["allowReopen"], "reopened": intent["reopened"], "completedByRunId": run["runId"]})
            state.retire("B", "reverted")
            log("Step B is not applied; flag cleared, generation retired.")
            return 0
        if not same_metadata(current, after):
            raise RuleError("metadata changed after step B; refusing to restore the old snapshot over it")
        # From here the backend refuses every narrowing; the comparison below cannot be overtaken.
        matrix_now = hasura.set_flag(False, run, {"operation": "revert-B-start", "step": "B", "generation": generation})
        lost = lost_grants(_read_json(os.path.join(current_dir, "matrix-at-B.json")), matrix_now)
        if lost:
            log(f"Role grants narrowed after step B ({len(lost)}): " + ", ".join(lost[:50]) + (" …" if len(lost) > 50 else ""))
            if not allow_reopen:
                hasura.set_flag(True, run, {"operation": "revert-B-refused", "step": "B", "generation": generation, "narrowed": lost})
                raise RuleError("revert would reopen these grants in Hasura; restore them first or pass --allow-reopen")
        # The intent (who, which run, override, reopened grants) is durable before the metadata changes.
        _write_json(intent_file, {"run": run, "allowReopen": allow_reopen, "reopened": lost})
        try:
            _replace_confirmed(hasura, resource_version, before, after)
        except UnknownStateError:
            raise  # flag stays false and B-current stays: a re-run finishes or reports the state
        except RuleError:
            # Only a confirmed B (metadata still «after») may get the flag back; an unknown state keeps it false.
            try:
                if same_metadata(hasura.export()[1], after):
                    hasura.set_flag(True, run, {"operation": "revert-B-failed", "step": "B", "generation": generation})
            except HasuraError:
                pass
            raise
        hasura.audit("permissions.hasura_access_predicates.step", run, {
            "step": "B", "result": "reverted", "generation": generation, "allowReopen": allow_reopen, "reopened": lost})
        state.retire("B", "reverted")
        log("Step B reverted to the metadata after step A; the backend now refuses every narrowing of the roles matrix.")
        return 0


def main(argv=None):
    import getpass
    import os
    import uuid
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    build = sub.add_parser("build")
    build.add_argument("--step", choices=["A", "B"], required=True)
    build.add_argument("--rules", required=True)
    st = sub.add_parser("status")
    st.add_argument("--rules", required=True)
    st.add_argument("--live", action="store_true")
    ap = sub.add_parser("apply")
    ap.add_argument("--rules", required=True)
    ap.add_argument("--step", choices=["A", "B"], required=True)
    ap.add_argument("--state-dir", required=True)
    ap.add_argument("--expect", required=True, help="approved metadata snapshot after step B (the release's metadata.json)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--operator", help="who runs it (audit); default: the OS account")
    rv = sub.add_parser("revert")
    rv.add_argument("--rules", required=True)
    rv.add_argument("--step", choices=["A", "B"], required=True)
    rv.add_argument("--state-dir", required=True)
    rv.add_argument("--allow-reopen", action="store_true")
    rv.add_argument("--operator", help="who runs it (audit); default: the OS account")
    args = parser.parse_args(argv)
    rules = _read_json(args.rules)

    def log(message):
        print(message, flush=True)

    def live():
        url, secret = os.environ.get("HASURA_BASE_URL", ""), os.environ.get("HASURA_ADMIN_SECRET", "")
        if not url or not secret:
            raise RuleError("HASURA_BASE_URL and HASURA_ADMIN_SECRET are required")
        return Hasura(url, secret)

    def run_context():
        try:
            account = getpass.getuser()
        except Exception:  # noqa: BLE001 — no account name in a minimal container
            account = "unknown"
        return {"runId": f"ops-access-predicates-{uuid.uuid4()}", "operator": args.operator or os.environ.get("SUDO_USER") or account}

    try:
        if args.cmd == "build":
            built = (build_step_a if args.step == "A" else build_step_b)(json.load(sys.stdin), rules)
            json.dump(built, sys.stdout, ensure_ascii=False, indent=2)
            sys.stdout.write("\n")
        elif args.cmd == "status":
            if args.live:
                hasura = live()
                result = status(hasura.export()[1], rules)
                print(f"A={result['A']} B={result['B']} flag={'true' if hasura.flag() else 'false'}")
            else:
                result = status(json.load(sys.stdin), rules)
                print(f"A={result['A']} B={result['B']}")
        elif args.cmd == "apply":
            run = run_context()
            log(f"Run {run['runId']} by {run['operator']}")
            return cmd_apply(live(), rules, args.step, args.state_dir, args.expect, args.dry_run, run, log)
        else:
            run = run_context()
            log(f"Run {run['runId']} by {run['operator']}")
            return cmd_revert(live(), args.step, args.state_dir, args.allow_reopen, run, log)
    except (RuleError, HasuraError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
