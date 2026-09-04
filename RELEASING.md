# Releasing

Public publication is an owner-authorized action. Preparation does not grant
authority to push, publish packages, upload images, or expose a live gateway.

From an exact clean commit:

```bash
./scripts/release-check
```

This runs TypeScript/Python/browser/native-soak/parity/package/security gates,
builds the tmux-free Docker image, executes its doctor command, and creates
checksummed npm packages, wheel, source distribution, source archive, npm
CycloneDX SBOM, and Python resolution report in `release-dist/`.

Before publication, record the reviewed source commit, Dolphin consumer
commit, Docker image ID, `SHA256SUMS`, and signer identity. Sign the exact
checksums or artifacts with the owner's established release key. Never create
an ad hoc signing identity merely to make a gate appear complete. Publish only
the exact reviewed artifacts, then verify registry/container downloads against
the recorded hashes.
