#!/usr/bin/env python3
"""Access groups 0Б: build Hasura metadata in which every permission requires the user's effective permission.

Rules: ops/hasura/access-predicates.json. Steps (plan report 2026-10-13, section 5; finances plan 2026-10-17 §2):
  A — additive: track user_effective_permissions / user_effective_scopes, add relationships, create the permissions of
      the admin role (erp_admin) with predicates. No existing role changes.
  B — every other role: wrap each permission in its predicate, drop revoked permissions. Fails on a permission that is
      neither in the rules nor an explicit exception.
  F1 — additive (finances): track the money projections and the relationships `financials` (source → projection); a
      projection has no root fields (query_root_fields: []), so it is reached only from a row the role may read — its
      select needs just orders.view_financials.
  F2 — every role's select of the money sources loses the money columns (they stay readable only through F1).
All steps are pure functions of (metadata, rules) and idempotent: a second build returns the same metadata.

CLI (used by access-predicates.sh and tests):
  access_predicates.py build --step A|B|F1|F2 --rules RULES.json < metadata.json > new-metadata.json
  access_predicates.py status --rules RULES.json < metadata.json       → prints "A=… B=… F1=… F2=…" (applied|missing)
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
        if name in projection_names(rules):
            continue  # permissions of the money projections are built by step F1
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
        if name in projection_names(rules):
            continue  # step F1
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


def projection_names(rules):
    return set((rules.get("financials") or {}).get("projections", {}))


def _add_relationship(entry, rel_type, name, remote_table, mapping):
    key = "object_relationships" if rel_type == "object" else "array_relationships"
    wanted = relationship_entry({"name": name, "remoteTable": remote_table, "columnMapping": mapping})
    existing = entry.setdefault(key, [])
    other = [r for r in existing if r["name"] == name]
    if other and other[0] != wanted:
        raise RuleError(f"{entry['table']['name']}.{name} exists with another definition")
    if not other:
        existing.append(wanted)


def build_step_f1(metadata, rules):
    """Money projections without root fields: a projection row is reachable only through `financials` of a source row
    the role already reads (its own filter, order scope, order kind), so the projection's filter adds only the money
    permission. No root field means no enumeration and no aggregate over the money of rows the role may not read —
    and Hasura does not re-plan the source's (heavy) filter for every money read (finances code review R1-5)."""
    metadata = copy.deepcopy(unwrap_export(metadata))
    tables = source_tables(metadata)
    fin = rules["financials"]
    for name, projection in fin["projections"].items():
        base = find_table(tables, projection["base"])
        if base is None:
            raise RuleError(f"projection {name}: base {projection['base']} is not tracked")
        entry = find_table(tables, name)
        if entry is None:
            entry = {"table": _table(name)}
            tables.append(entry)
        roles = sorted({perm["role"] for source_name, source in fin["sources"].items() if source["projection"] == name
                        for perm in (find_table(tables, source_name) or {}).get("select_permissions") or []})
        for op in OPS:
            entry.pop(f"{op}_permissions", None)
        if roles:
            entry["select_permissions"] = [{"role": role, "permission": {
                # No allow_aggregations (false is Hasura's default and is not exported).
                "columns": list(projection["columns"]), "filter": perm_exists(fin["permission"]),
                "query_root_fields": [], "subscription_root_fields": []}} for role in roles]
    for name, source in fin["sources"].items():
        entry = find_table(tables, name)
        if entry is None:
            raise RuleError(f"money source {name} is not tracked")
        _add_relationship(entry, "object", fin["relationship"], source["projection"], source["mapping"])
    return metadata


def build_step_f2(metadata, rules):
    metadata = copy.deepcopy(unwrap_export(metadata))
    tables = source_tables(metadata)
    for name, source in rules["financials"]["sources"].items():
        entry = find_table(tables, name)
        if entry is None:
            raise RuleError(f"money source {name} is not tracked")
        money = set(source["financialColumns"])
        known = money | set(source["otherColumns"])
        for op in ("insert", "update"):
            for perm in entry.get(f"{op}_permissions") or []:
                columns = perm["permission"].get("columns")
                if columns == "*" or money & set(columns or []):
                    raise RuleError(f"{name}.{op}/{perm['role']} writes money columns: not expected (backend-owned)")
        for perm in entry.get("select_permissions") or []:
            columns = perm["permission"].get("columns")
            if columns == "*":
                perm["permission"]["columns"] = list(source["otherColumns"])
                continue
            unknown = sorted(set(columns or []) - known)
            if unknown:
                raise RuleError(f"{name} select/{perm['role']} has columns unknown to the rules: {', '.join(unknown)}")
            perm["permission"]["columns"] = [c for c in columns if c not in money]
    return metadata


STEPS = ("A", "B", "F1", "F2")
BUILDERS = {"A": build_step_a, "B": build_step_b, "F1": build_step_f1, "F2": build_step_f2}


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
    result = {}
    previous = True
    for step in STEPS:
        if step in ("F1", "F2") and not rules.get("financials"):
            continue
        try:
            applied = previous and same_metadata(BUILDERS[step](metadata, rules), metadata)
        except RuleError:
            if step == "A":
                raise  # rules that do not fit the metadata at all (an untracked table) are an error, not «missing»
            applied = False
        result[step] = "applied" if applied else "missing"
        previous = applied
    return result


def status_line(result):
    return " ".join(f"{step}={value}" for step, value in result.items())


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


# Access groups (plan 2026-10-29 R7 §6): while permissions_state.access_groups_enabled is on, group grants reach Hasura
# only through the predicates of B and the money columns closed by F2, so neither may be reverted. The check runs after
# the permissions_state lock in the same transaction as the revert's barrier: the backend command that turns groups on
# takes that lock too, so a revert and an enable cannot overtake each other. Column-agnostic (before migration 285 the
# column is missing and the switch counts as off).
GROUPS_ENABLED_MARKER = "ACCESS_GROUPS_ENABLED"


def groups_off_guard_sql(step):
    return ("DO $ag_guard$ BEGIN IF (SELECT coalesce((to_jsonb(ps) ->> 'access_groups_enabled')::boolean, false) "
            "FROM public.permissions_state ps WHERE ps.id = true) THEN "
            f"RAISE EXCEPTION '{GROUPS_ENABLED_MARKER}: access groups are on; turn them off before reverting step {step}'; "
            "END IF; END $ag_guard$; ")


def flag_sql(value, run, details, groups_off_step=None):
    """Lock permissions_state (lock order of the matrix commands), audit, set the flag, return the role matrix.
    `groups_off_step`: refuse (whole transaction) while access groups are on."""
    state = "true" if value else "false"
    metadata = {"correlationId": run["runId"], "operator": run["operator"], **details}
    return (
        "SELECT version FROM public.permissions_state WHERE id = true FOR UPDATE; "
        + (groups_off_guard_sql(groups_off_step) if groups_off_step else "") +
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


# Finances (plan 2026-10-17 §2.3): permissions_state.hasura_financials_state (migration 258) is
#   open      — money columns readable by every role that reads the row; the backend refuses to take
#               orders.view_financials from a role (PERMISSION_NARROWING_BLOCKED);
#   closed    — step F2 applied: money only through the projections; narrowing allowed;
#   reverting — a revert of F2 is under way: the backend refuses EVERY authorization change (matrix, user role, groups;
#               409 AUTHORIZATION_CHANGES_PAUSED), so nobody can lose the right between the check and the restore.
# F2 records the users with the right in permissions_state.hasura_financials_users, in the same transaction as `closed`
# (a lost answer or a crash cannot separate them); the revert refuses when one of them lost the right.

FIN_STATE_READ = ("SELECT coalesce(to_jsonb(ps) ->> 'hasura_financials_state', 'open') "
                  "FROM public.permissions_state ps WHERE ps.id = true")


def _fin_users_sql(permission):
    return ("SELECT u.user_id::text FROM public.users u WHERE u.is_active AND EXISTS (SELECT 1 FROM "
            f"public.user_effective_permissions p WHERE p.user_id = u.user_id AND p.permission_name = {_quote(permission)})")


def _fin_audit_sql(target, run, details, condition="true", extra_metadata_sql=None):
    metadata = {"correlationId": run["runId"], "operator": run["operator"], **details}
    metadata_sql = _jsonb(metadata) + (f" || {extra_metadata_sql}" if extra_metadata_sql else "")
    return (
        "INSERT INTO public.audit_log (event, entity_type, entity_id, username, request_id, source, before_json, after_json, diff_json, metadata_json) "
        "SELECT 'permissions.hasura_financials_state.update', 'permissions_state', 'hasura_financials_state', "
        f"{_quote('ops:' + run['operator'])}, {_quote(run['runId'])}, 'ops', "
        "jsonb_build_object('hasuraFinancialsState', hasura_financials_state), "
        f"jsonb_build_object('hasuraFinancialsState', {_quote(target)}), "
        f"jsonb_build_object('hasuraFinancialsState', jsonb_build_object('from', hasura_financials_state, 'to', {_quote(target)})), "
        f"{metadata_sql} "
        f"FROM public.permissions_state WHERE id = true AND hasura_financials_state IS DISTINCT FROM {_quote(target)} AND ({condition}); "
    )


FIN_USERS_READ = ("SELECT coalesce(to_jsonb(ps) -> 'hasura_financials_users', 'null'::jsonb)::text "
                  "FROM public.permissions_state ps WHERE ps.id = true")

_SNAPSHOT_ROWS = ("SELECT u.value FROM public.permissions_state ps, jsonb_array_elements_text(coalesce(ps.hasura_financials_users, "
                  "'[]'::jsonb)) AS u(value) WHERE ps.id = true")


def _revert_intent_sql(run, allow_reopen, reopened_sql):
    return (f"jsonb_build_object('run', {_jsonb(run)}, 'allowReopen', {'true' if allow_reopen else 'false'}, "
            f"'reopened', {reopened_sql})")


def fin_state_sql(target, permission, run, details, keep_users=False, revert_intent=None):
    """Lock permissions_state (the lock every authorization command takes first), audit and set the state; `closed`
    stores the users holding the money permission in the same transaction (unless `keep_users`: back from a failed
    revert, the snapshot of F2 stays), `open` clears them. Returns the snapshot."""
    if keep_users:
        users = "hasura_financials_users"
    elif target == "closed":
        users = (f"(SELECT coalesce(jsonb_agg(f.user_id ORDER BY f.user_id::bigint), '[]'::jsonb) "
                 f"FROM ({_fin_users_sql(permission)}) AS f(user_id))")
    elif target == "open":
        users = "NULL"
    else:
        users = "hasura_financials_users"
    # The intent of a revert lives only while `reverting` (set with the barrier, cleared by `closed`/`open`).
    intent = _jsonb(revert_intent) if (target == "reverting" and revert_intent is not None) else (
        "hasura_financials_revert" if target == "reverting" else "NULL")
    return ("SELECT version FROM public.permissions_state WHERE id = true FOR UPDATE; "
            + (groups_off_guard_sql("F2") if target == "reverting" else "")
            + _fin_audit_sql(target, run, details)
            + f"UPDATE public.permissions_state SET hasura_financials_state = {_quote(target)}, hasura_financials_users = {users}, "
            f"hasura_financials_revert = {intent}, updated_at = now() WHERE id = true; "
            + _SNAPSHOT_ROWS)


def _lost_users_sql(permission):
    """Users of the F2 snapshot (permissions_state.hasura_financials_users) who no longer hold the permission but still
    read money sources (orders / doweling orders)."""
    return ("SELECT s.user_id::text FROM public.permissions_state ps, "
            "jsonb_array_elements_text(coalesce(ps.hasura_financials_users, '[]'::jsonb)) AS s(user_id) "
            "JOIN public.users u ON u.user_id = s.user_id::bigint "
            "WHERE ps.id = true AND u.is_active AND NOT EXISTS (SELECT 1 FROM public.user_effective_permissions p "
            f"WHERE p.user_id = u.user_id AND p.permission_name = {_quote(permission)}) AND EXISTS (SELECT 1 FROM "
            "public.user_effective_permissions p WHERE p.user_id = u.user_id AND p.permission_name IN ('orders.view', 'doweling.view'))")


def revert_start_sql(permission, allow_reopen, run, details):
    """Under the permissions_state lock: closed → reverting unless the snapshot is missing or a snapshot user lost the
    right (both pass only with --allow-reopen); returns the users who lost it either way."""
    lost = _lost_users_sql(permission)
    reopened = f"(SELECT coalesce(jsonb_agg(l.user_id ORDER BY l.user_id::bigint), '[]'::jsonb) FROM ({lost}) AS l(user_id))"
    condition = "true" if allow_reopen else f"hasura_financials_users IS NOT NULL AND NOT EXISTS ({lost})"
    # The barrier, its audit (override + reopened users) and the durable intent of this revert: one transaction.
    return ("SELECT version FROM public.permissions_state WHERE id = true FOR UPDATE; "
            + groups_off_guard_sql("F2")
            + _fin_audit_sql("reverting", run, {**details, "allowReopen": allow_reopen},
                             f"hasura_financials_state = 'closed' AND {condition}", f"jsonb_build_object('reopened', {reopened})")
            + "UPDATE public.permissions_state SET hasura_financials_state = 'reverting', "
            f"hasura_financials_revert = {_revert_intent_sql(run, allow_reopen, reopened)}, updated_at = now() "
            f"WHERE id = true AND hasura_financials_state = 'closed' AND {condition}; "
            + lost)


class HasuraError(Exception):
    def __init__(self, status_code, body):
        super().__init__(f"HTTP {status_code}: {body[:300]}")
        self.status_code = status_code
        self.body = body


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
        # to_jsonb: before migration 253 the column does not exist and the answer is false, not an error.
        rows = self._rows("SELECT coalesce((to_jsonb(ps) ->> 'hasura_access_predicates')::boolean, false)::text "
                          "FROM public.permissions_state ps WHERE ps.id = true", True)
        return rows == ["true"]

    def set_flag(self, value, run, details, groups_off_step=None):
        """Sets the flag under the permissions_state lock and returns the role matrix of that same transaction."""
        return sorted(self._groups_off(lambda: self._rows(flag_sql(value, run, details, groups_off_step), False)))

    @staticmethod
    def _groups_off(call):
        """The refusal of groups_off_guard_sql as a RuleError (nothing of that transaction was written)."""
        try:
            return call()
        except HasuraError as error:
            if GROUPS_ENABLED_MARKER in getattr(error, "body", ""):
                raise RuleError("access groups are on (permissions_state.access_groups_enabled): turn them off in "
                                "«Конфигурация → Группы доступа» first; nothing was changed") from None
            raise

    def audit(self, event, run, details):
        self._rows(audit_sql(event, run, details) + "SELECT 'ok'", False)

    def financials_state(self):
        rows = self._rows(FIN_STATE_READ, True)
        return rows[0] if rows else "open"

    def set_financials_state(self, target, permission, run, details, keep_users=False, revert_intent=None):
        return sorted(self._groups_off(lambda: self._rows(fin_state_sql(target, permission, run, details, keep_users, revert_intent), False)), key=int)

    def financials_revert(self):
        """The durable intent of the revert under way (None outside `reverting`)."""
        rows = self._rows("SELECT coalesce(to_jsonb(ps) -> 'hasura_financials_revert', 'null'::jsonb)::text "
                          "FROM public.permissions_state ps WHERE ps.id = true", True)
        return json.loads(rows[0]) if rows else None

    def revert_financials_start(self, permission, allow_reopen, run, details):
        return sorted(self._groups_off(lambda: self._rows(revert_start_sql(permission, allow_reopen, run, details), False)), key=int)

    def financials_users(self):
        """The users snapshot of F2 stored with `closed` (None when there is none)."""
        rows = self._rows(FIN_USERS_READ, True)
        value = json.loads(rows[0]) if rows else None
        return None if value is None else sorted((str(user) for user in value), key=int)

    def columns(self, names):
        quoted = ",".join(_quote(name) for name in sorted(names))
        rows = self._rows("SELECT table_name || '|' || string_agg(column_name, ',' ORDER BY column_name) FROM "
                          f"information_schema.columns WHERE table_schema = 'public' AND table_name IN ({quoted}) "
                          "GROUP BY table_name", True)
        return {row.split("|", 1)[0]: set(row.split("|", 1)[1].split(",")) for row in rows}


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


def check_financial_columns(hasura, rules):
    """Before F2: the rules' column lists must be exactly the database columns (else F2 would hide or keep a column
    nobody reviewed), and the projections must exist with their columns."""
    fin = rules["financials"]
    names = set(fin["sources"]) | set(fin["projections"])
    actual = hasura.columns(names)
    problems = []
    for name, source in fin["sources"].items():
        wanted = set(source["financialColumns"]) | set(source["otherColumns"])
        if actual.get(name) != wanted:
            got = actual.get(name, set())
            problems.append(f"{name}: database has {sorted(got - wanted)} not in the rules, rules have {sorted(wanted - got)} not in the database")
    for name, projection in fin["projections"].items():
        if not set(projection["columns"]) <= actual.get(name, set()):
            problems.append(f"projection {name} is missing (migration 258?) or lacks {sorted(set(projection['columns']) - actual.get(name, set()))}")
    if problems:
        raise RuleError("money columns of the rules differ from the database: " + "; ".join(problems))


def _finish_f2(hasura, rules, state, generation, run, log):
    """After the metadata of F2 is confirmed: state `closed` and the users holding the money permission, in one
    transaction (so the snapshot is exactly the set the revert must protect), then the confirmed generation."""
    import os
    permission = rules["financials"]["permission"]
    users_file = os.path.join(generation, "users-at-F2.json")
    origin = _read_json(os.path.join(generation, "intent.json"))["run"] if os.path.exists(os.path.join(generation, "intent.json")) else run
    fin_state = hasura.financials_state()
    if fin_state == "reverting":
        # Applying F2 during an interrupted revert cancels that revert: the columns stay closed and the protection
        # baseline stays the ORIGINAL snapshot (a fresh one would drop users who lost the right meanwhile).
        hasura.set_financials_state("closed", permission, run, {
            "operation": "apply-F2-cancels-revert", "step": "F2", "generation": os.path.basename(generation)}, keep_users=True)
    elif fin_state != "closed":
        # `closed` and the users snapshot are one transaction; the local file is only a copy of it.
        hasura.set_financials_state("closed", permission, run, {
            "operation": "apply-F2", "step": "F2", "generation": os.path.basename(generation), "originRunId": origin["runId"]})
    users = hasura.financials_users()
    if users is None:
        raise RuleError("the state is closed without a users snapshot (closed outside this script?): the rollback baseline "
                        "is missing; a revert of F2 then needs --allow-reopen")
    _write_json(users_file, users)
    hasura.audit("permissions.hasura_access_predicates.step", origin, {"step": "F2", "result": "applied", "generation": os.path.basename(generation)})
    if generation != state.current("F2"):
        state.confirm("F2", generation)


def cmd_apply(hasura, rules, step, state_dir, expect_path, dry_run, run, log):
    import os
    expected = _read_json(expect_path)
    with StateDir(state_dir) as state:
        resource_version, current = hasura.export()
        position = STEPS.index(step)
        live = status(current, rules)
        missing = [s for s in STEPS[:position] if live.get(s) != "applied"]
        if missing:
            raise RuleError(f"step {missing[0]} is not applied; run --step {missing[0]} first")
        built = BUILDERS[step](current, rules)
        final = built
        for later in STEPS[position + 1:]:
            if later in BUILDERS and (later not in ("F1", "F2") or rules.get("financials")):
                final = BUILDERS[later](final, rules)
        if not same_metadata(final, expected):
            raise RuleError("the live metadata does not lead to the approved snapshot (--expect): unknown drift; nothing applied")
        if step == "F2":
            check_financial_columns(hasura, rules)
        applied = same_metadata(built, current)
        if dry_run:
            extra = ""
            if step == "B":
                extra = f"; flag={'true' if hasura.flag() else 'false'}"
            elif step == "F2":
                extra = f"; financials={hasura.financials_state()}"
            log(f"Dry run: step {step} metadata {'already applied' if applied else 'would change'}{extra}. Nothing changed.")
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
            elif step == "F2":
                _finish_f2(hasura, rules, state, generation, run, log)
            elif generation != state.current(step):
                intent_file = os.path.join(generation, "intent.json")
                origin = _read_json(intent_file)["run"] if os.path.exists(intent_file) else run
                hasura.audit("permissions.hasura_access_predicates.step", origin, {"step": step, "result": "applied", "generation": os.path.basename(generation)})
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
        elif step == "F2":
            _finish_f2(hasura, rules, state, pending, run, log)
        else:
            hasura.audit("permissions.hasura_access_predicates.step", run, {"step": step, "result": "applied", "generation": os.path.basename(pending)})
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
        matrix_now = hasura.set_flag(False, run, {"operation": "revert-B-start", "step": "B", "generation": generation},
                                     groups_off_step="B")
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


def _f2_generation(state, current):
    """The confirmed generation of F2, or the pending one whose result is the live metadata (an apply of F2 that stopped
    after the metadata changed — its revert must still be possible); that one is confirmed now."""
    import os
    if os.path.isdir(state.current("F2")):
        return state.current("F2")
    resumable = [g for g in state.pendings("F2") if same_metadata(_read_json(os.path.join(g, "after.json")), current)]
    if not resumable:
        return None
    state.confirm("F2", resumable[-1])
    return state.current("F2")


def cmd_revert_f2(hasura, rules, state_dir, allow_reopen, run, log):
    import os
    permission = rules["financials"]["permission"]
    with StateDir(state_dir) as state:
        resource_version, current = hasura.export()
        current_dir = _f2_generation(state, current)
        if current_dir is None:
            raise RuleError(f"no step F2 generation in {state_dir} for the live metadata")
        generation = os.path.basename(current_dir)
        before = _read_json(os.path.join(current_dir, "before.json"))
        after = _read_json(os.path.join(current_dir, "after.json"))
        intent_file = os.path.join(current_dir, "revert-intent.json")
        fin_state = hasura.financials_state()

        def finish(origin, details):
            if hasura.financials_state() != "open":
                hasura.set_financials_state("open", permission, run, {"operation": "revert-F2-finish", "step": "F2", "generation": generation})
            hasura.audit("permissions.hasura_access_predicates.step", origin, {"step": "F2", "result": "reverted", "generation": generation, **details})
            state.retire("F2", "reverted")

        if same_metadata(current, before):
            # An earlier revert restored the columns but did not finish: lift the barrier and complete ITS audit.
            intent = hasura.financials_revert() or (_read_json(intent_file) if os.path.exists(intent_file) else
                                                    {"run": run, "allowReopen": allow_reopen, "reopened": []})
            finish(intent["run"], {"allowReopen": intent["allowReopen"], "reopened": intent["reopened"], "completedByRunId": run["runId"]})
            log("Step F2 is not applied; financials state open, generation retired.")
            return 0
        if not same_metadata(current, after):
            raise RuleError("metadata changed after step F2; refusing to restore the old snapshot over it")
        if fin_state == "reverting":
            # Recovery of the same operation (its barrier is still up): its intent is in the database, set with the
            # barrier (operator, override, reopened users) — a lost answer of the start cannot lose it.
            intent = hasura.financials_revert()
            if intent is None:
                raise RuleError("state reverting without a recorded revert intent: finish manually (apply --step F2 "
                                "to close again, or restore the metadata and set the state open)")
        elif fin_state == "closed":
            lost = hasura.revert_financials_start(permission, allow_reopen, run,
                                                  {"operation": "revert-F2-start", "step": "F2", "generation": generation})
            if lost:
                log(f"Users who lost {permission} after step F2 ({len(lost)}): " + ", ".join(lost[:50]) + (" …" if len(lost) > 50 else ""))
            if hasura.financials_state() != "reverting":
                if hasura.financials_users() is None:
                    raise RuleError("no users snapshot of step F2: the revert cannot check who lost the right; use --allow-reopen")
                raise RuleError("revert would give these users the money columns again; restore their right first or pass --allow-reopen")
            intent = hasura.financials_revert()
        else:
            # `open` with closed columns: an apply of F2 stopped before its state; nothing was narrowed under it.
            intent = {"run": run, "allowReopen": allow_reopen, "reopened": []}
            hasura.set_financials_state("reverting", permission, run, {"operation": "revert-F2-start", "step": "F2", "generation": generation},
                                        revert_intent=intent)
        _write_json(intent_file, intent)  # local copy of the durable intent
        # From here every authorization change is refused (state `reverting`) until the columns are back.
        try:
            _replace_confirmed(hasura, resource_version, before, after)
        except UnknownStateError:
            raise  # state stays `reverting`: a re-run finishes once the outcome is known
        except RuleError:
            # Confirmed: the columns are still closed. Back to `closed`; the attempt is over, so is its intent.
            try:
                if same_metadata(hasura.export()[1], after):
                    hasura.set_financials_state("closed", permission, run, {"operation": "revert-F2-failed", "step": "F2", "generation": generation},
                                                keep_users=True)
                    os.remove(intent_file)
            except (HasuraError, OSError):
                pass
            raise
        finish(intent["run"], {"allowReopen": intent["allowReopen"], "reopened": intent["reopened"]})
        log("Step F2 reverted: money columns are readable again by every role that reads the row; the backend refuses "
            "to take orders.view_financials from a role.")
        return 0


def cmd_revert_f1(hasura, state_dir, run, log):
    """F1 is additive (projections + relationships): restore the metadata before it. Only while F2 is not applied (the
    revert of F2 comes first), and only over exactly the F1 result. Needed before a revert of B."""
    import os
    with StateDir(state_dir) as state:
        current_dir = state.current("F1")
        if not os.path.isdir(current_dir):
            raise RuleError(f"no confirmed step F1 in {state_dir}")
        if os.path.isdir(state.current("F2")):
            raise RuleError("step F2 is confirmed: revert F2 first")
        resource_version, current = hasura.export()
        before = _read_json(os.path.join(current_dir, "before.json"))
        after = _read_json(os.path.join(current_dir, "after.json"))
        if not same_metadata(current, before):
            if not same_metadata(current, after):
                raise RuleError("metadata changed after step F1; refusing to restore the old snapshot over it")
            _replace_confirmed(hasura, resource_version, before, after)
        hasura.audit("permissions.hasura_access_predicates.step", run, {"step": "F1", "result": "reverted", "generation": os.path.basename(current_dir)})
        state.retire("F1", "reverted")
        log("Step F1 reverted: the money projections are no longer tracked.")
        return 0


def main(argv=None):
    import getpass
    import os
    import uuid
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    build = sub.add_parser("build")
    build.add_argument("--step", choices=list(STEPS), required=True)
    build.add_argument("--rules", required=True)
    st = sub.add_parser("status")
    st.add_argument("--rules", required=True)
    st.add_argument("--live", action="store_true")
    ap = sub.add_parser("apply")
    ap.add_argument("--rules", required=True)
    ap.add_argument("--step", choices=list(STEPS), required=True)
    ap.add_argument("--state-dir", required=True)
    ap.add_argument("--expect", required=True, help="approved metadata snapshot after step B (the release's metadata.json)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--operator", help="who runs it (audit); default: the OS account")
    rv = sub.add_parser("revert")
    rv.add_argument("--rules", required=True)
    rv.add_argument("--step", choices=["A", "B", "F1", "F2"], required=True)
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
            built = BUILDERS[args.step](json.load(sys.stdin), rules)
            json.dump(built, sys.stdout, ensure_ascii=False, indent=2)
            sys.stdout.write("\n")
        elif args.cmd == "status":
            if args.live:
                hasura = live()
                result = status(hasura.export()[1], rules)
                extra = f" financials={hasura.financials_state()}" if rules.get("financials") else ""
                print(f"{status_line(result)} flag={'true' if hasura.flag() else 'false'}{extra}")
            else:
                print(status_line(status(json.load(sys.stdin), rules)))
        elif args.cmd == "apply":
            run = run_context()
            log(f"Run {run['runId']} by {run['operator']}")
            return cmd_apply(live(), rules, args.step, args.state_dir, args.expect, args.dry_run, run, log)
        else:
            run = run_context()
            log(f"Run {run['runId']} by {run['operator']}")
            if args.step == "F2":
                return cmd_revert_f2(live(), rules, args.state_dir, args.allow_reopen, run, log)
            if args.step == "F1":
                return cmd_revert_f1(live(), args.state_dir, run, log)
            return cmd_revert(live(), args.step, args.state_dir, args.allow_reopen, run, log)
    except (RuleError, HasuraError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
