"""Translate the backend Traefik labels of the compose templates into a
Traefik file-provider dynamic configuration for the local ingress harnesses.

The harness containers carry NO Traefik labels: the shared Traefik of the
host (docker provider) must never see them (a duplicate `backend` router
there breaks the stage routing). The harness Traefik uses only this file.

Usage: python3 onec_ingress_labels_to_file.py <repo> <out.yml> <subst.json> <backend-host>
"""
import json
import sys

import yaml

repo, out, subst_path, backend_host = sys.argv[1:]
subst = json.load(open(subst_path))
vps = yaml.safe_load(open(f"{repo}/ops/templates/docker-compose.vps.yml"))
overlay = yaml.safe_load(open(f"{repo}/ops/templates/docker-compose.onec-agent.yml"))

config: dict = {}
for label in vps["services"]["backend"]["labels"] + overlay["services"]["backend"]["labels"]:
    for key, value in subst.items():
        label = label.replace(key, value)
    key, _, value = label.partition("=")
    if not key.startswith("traefik.http."):
        continue  # traefik.enable / traefik.docker.network: docker-provider only
    parts = key.split(".")[1:]  # http.<kind>.<name>.<path...>
    if parts[1] == "routers" and parts[3:] == ["tls", "certresolver"]:
        parts, value = parts[:3] + ["tls"], {}  # no ACME in the harness: Traefik's TLS with file certificates
    if parts[1] == "services" and parts[3:] == ["loadbalancer", "server", "port"]:
        parts, value = parts[:3] + ["loadBalancer", "servers"], [{"url": f"http://{backend_host}:{value}"}]
    # Docker labels are case-insensitive; the file provider needs the canonical key names.
    canon = {"entrypoints": "entryPoints", "customrequestheaders": "customRequestHeaders",
             "passtlsclientcert": "passTLSClientCert", "ratelimit": "rateLimit", "loadbalancer": "loadBalancer"}
    parts = [canon.get(part, part) for part in parts]
    if isinstance(value, str):
        if parts[-1] in ("entryPoints", "middlewares"):
            value = value.split(",")
        elif value in ("true", "false"):
            value = value == "true"
        elif value.isdigit():
            value = int(value)
    node = config
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = value

# File provider references its own TLS options without the @file suffix.
for router in config.get("http", {}).get("routers", {}).values():
    tls = router.get("tls")
    if isinstance(tls, dict) and isinstance(tls.get("options"), str):
        tls["options"] = tls["options"].removesuffix("@file")
yaml.safe_dump(config, open(out, "w"), sort_keys=False)
