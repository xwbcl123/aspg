# Wave 2A Portfolio Fixtures

These fixtures exercise the lock-free, schema-only Wave 2A baseline.

- `portfolio.yaml` mirrors the private authoritative Manifest.
- `bindings/` contains schema examples only and pins the real Wave 1 baseline
  revision. No real project binding is created; a later Git promotion must
  refresh the examples to the committed Manifest revision before activation.
- `device-registry-v2.yaml` keeps runtime backend selection device-local.
- `life-os-current` and `work-pkm-current` preserve the two current materialized
  exposure sets without manufacturing a single inflated cross-project profile.
- The Life runtime root uses `managed-materialized` on Google Drive.
- The Work local runtime root uses `managed-link`.
- The Work Drive twin is intentionally absent. It may be added later only when
  Claude cannot consume the local root, and then only as a
  `managed-materialized` runtime root resolving the same future Lock.
- No Portfolio Lock, deployment state or runtime path is present in this
  fixture set.
