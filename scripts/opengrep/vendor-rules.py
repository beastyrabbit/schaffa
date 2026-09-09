#!/usr/bin/env python3
"""Generate a reviewable patch for pinned upstream rule sources; never fetch or execute them.

Usage: python3 vendor-rules.py /path/to/checked-out-sources > /tmp/rules.patch
Apply the patch with the normal patch tool, review the manifest and validate with OpenGrep.
Requires PyYAML on the maintainer's workstation only, not in scan jobs.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import yaml

SOURCES = {
    "gitlab": ("https://github.com/qodana/opengrep-sast-rules", "75fa06c3862b0c2acc019246c93d64600aaf0197",
               ["c", "csharp", "go", "javascript", "python", "scala", "rules/lgpl"], "MIT; rules/lgpl: LGPL-3.0"),
    "trailofbits": ("https://github.com/trailofbits/semgrep-rules", "31390b3a99c04c81522d1b37c8d1900aa2dd4094",
                    ["generic", "go", "hcl", "javascript", "jvm", "python", "rs", "ruby", "swift", "yaml"], "AGPL-3.0"),
    "elttam": ("https://github.com/elttam/semgrep-rules", "244268562cc92d33f54b8a60a187df5520f91b26",
               ["rules", "rules-audit"], "MIT"),
    "0xdea": ("https://github.com/0xdea/semgrep-rules", "33155497b25b4639193db016962af2df46290b10", ["."], "MIT"),
    "patched": ("https://github.com/patched-codes/semgrep-rules", "1118d79823ae756534678378a4aac0cbfa5d3041", ["java"], "MIT"),
    "aikido": ("https://github.com/AikidoSec/opengrep-rules", "7ac79affecf709eb7263a243b518a417cd7e0ab2", ["."], "MIT"),
}
LANGUAGES = {"web": {"javascript", "typescript", "js", "ts"}, "python": {"python"}, "go": {"go"},
             "c-cpp": {"c", "cpp"}, "dotnet": {"csharp"}, "jvm": {"java", "kotlin", "scala"},
             "swift": {"swift"}, "ruby": {"ruby"}, "rust": {"rust"}, "php": {"php"},
             "config": {"generic", "regex", "yaml", "hcl", "dockerfile", "bash"}}

root = Path(sys.argv[1]).resolve()
target = Path(__file__).resolve().parents[2] / ".github/opengrep/vendor"
EXCLUDED = {"elttam/rules/generic/jsp-likely-xss.yaml": "Invalid upstream rule: missing languages; OpenGrep 1.30.0 rejects it"}
manifest = {"sources": {}, "profiles": {name: [] for name in LANGUAGES}, "rules": {}, "excluded": EXCLUDED}
files = {}
for name, (url, revision, directories, license_name) in SOURCES.items():
    source = root / name
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    if actual != revision:
        raise SystemExit(f"Wrong upstream revision for {name}")
    manifest["sources"][name] = {"url": url, "revision": revision, "license": license_name}
    licenses = [p for p in source.rglob("LICENSE*") if ".git" not in p.parts and "jetbrains" not in p.parts]
    for p in licenses:
        files[f"{name}/{p.relative_to(source)}"] = p.read_text()
    seen = set()
    for directory in directories:
        for p in sorted((source / directory).rglob("*")):
            if p.suffix not in {".yaml", ".yml"} or p.is_symlink() or ".git" in p.parts:
                continue
            content = p.read_text()
            documents = list(yaml.safe_load_all(content))
            if len(documents) != 1:
                continue
            data = documents[0]
            if not isinstance(data, dict) or not isinstance(data.get("rules"), list):
                continue
            relative = f"{name}/{p.relative_to(source)}"
            if relative in EXCLUDED:
                continue
            applicable = set()
            for rule in data["rules"]:
                rule_id = rule["id"]
                if rule_id in seen:
                    raise SystemExit(f"Duplicate rule ID in {name}: {rule_id}")
                seen.add(rule_id)
                for profile, languages in LANGUAGES.items():
                    if languages.intersection(rule.get("languages", [])):
                        applicable.add(profile)
                manifest["rules"].setdefault(rule_id, []).append(relative)
            files[relative] = content
            for profile in applicable:
                manifest["profiles"][profile].append(relative)
    manifest["sources"][name]["rules"] = len(seen)

manifest["upstreamSha256"] = [[path, hashlib.sha256(content.encode()).hexdigest()] for path, content in sorted(files.items())]
manifest["sha256"] = [[path, hashlib.sha256((content if content.endswith("\n") else content + "\n").encode()).hexdigest()] for path, content in sorted(files.items())]
files["manifest.json"] = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
print("*** Begin Patch")
for relative, content in sorted(files.items()):
    if len(sys.argv) > 2 and not relative.startswith(sys.argv[2]):
        continue
    destination = target / relative
    if destination.exists():
        raise SystemExit(f"Existing vendor file needs an explicit update patch: {destination}")
    print(f"*** Add File: {destination}")
    for line in content.splitlines():
        print("+" + line)
print("*** End Patch")
