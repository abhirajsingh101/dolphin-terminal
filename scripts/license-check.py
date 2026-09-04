"""Fail when direct Python runtime dependencies use an unreviewed license."""

from importlib import metadata


ALLOWED = {
    "fastapi": {"MIT"},
    "pillow": {"HPND", "MIT-CMU"},
    "uvicorn": {"BSD-3-Clause"},
}


def license_expression(distribution: metadata.Distribution) -> str:
    expression = distribution.metadata.get("License-Expression")
    if expression:
        return expression.strip()
    classifiers = distribution.metadata.get_all("Classifier", [])
    known = {
        "License :: OSI Approved :: BSD License": "BSD-3-Clause",
        "License :: OSI Approved :: MIT License": "MIT",
        "License :: OSI Approved :: Historical Permission Notice and Disclaimer (HPND)": "HPND",
    }
    for classifier in classifiers:
        if classifier in known:
            return known[classifier]
    return (distribution.metadata.get("License") or "UNKNOWN").strip()


def main() -> None:
    reviewed: list[str] = []
    for package, allowed in ALLOWED.items():
        distribution = metadata.distribution(package)
        expression = license_expression(distribution)
        if expression not in allowed:
            raise SystemExit(
                f"{package} {distribution.version} uses unreviewed license {expression}"
            )
        reviewed.append(f"{package}={distribution.version}:{expression}")
    print("PYTHON_LICENSES=PASS " + " ".join(reviewed))


if __name__ == "__main__":
    main()
