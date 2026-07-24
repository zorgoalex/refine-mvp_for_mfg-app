# Design handoff manifest

Authoritative source root:

`/home/ovhtest/projects/erp_dev/spec_erp/plans/ui-redesign/docs`

Required sources verified during discovery:

- `IMPLEMENTATION_TASK.md`
- `SCREEN_MAP.csv`
- `ACCEPTANCE_CHECKLIST.md`
- `UI_VARIANT_SWITCHING_SPEC.md`
- `UI_VARIANT_ACCEPTANCE_CHECKLIST.md`
- `design-reference/DESIGN_CHANGES.md`
- `design-reference/prototype.html`
- `design-reference/comparison.html`
- all 20 files under `design-reference/assets/{before,after}`
- both supplied PDFs (10 pages each)

The handoff is intentionally not duplicated into the application repository. `SCREEN_MAP.csv` uses absolute workspace paths so branch review can open the exact source assets without stale binary copies.
