import json
from pathlib import Path

from spaday.semver import satisfies

from spaday_perspective import package

PACKAGE_JSON = Path(__file__).parent.parent.parent / "js" / "package.json"


def test_the_package_records_the_js_versions_it_serves():
    assert package.provides, "the JS build writes extension/versions.json; run it first"
    declared = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["dependencies"]
    served = dict(package.provides)
    assert served.keys() == declared.keys()
    for name, version in served.items():
        # what the build installed and serves is inside what package.json asks for
        assert satisfies(version, declared[name]), (name, version, declared[name])
