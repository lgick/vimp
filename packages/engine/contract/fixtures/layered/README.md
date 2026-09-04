# Layered map fixtures

One corpus of maps shared by the two checkers that enforce the same rules:

* `vimp-engine-core` — `MapConfig::validate` (Rust, load time), test
  `map::tests::shared_layered_fixtures`;
* the contract checker — rule `E4 mapLayers` (JS, before the build), test
  `tests/devtools/contract/e4-map-layers.test.js`.

Each file holds one map under `map`, a human note under `note` and — for the
broken ones — the fragment both checkers must report under `expect`. The
wording of the two messages differs; the fragment is what they agree on. A
rule that drifts on one side and not the other fails its own suite here
instead of failing silently on a real map.

`good.json` has no `expect`: both checkers must accept it.

Add a fixture whenever a rule is added, and keep exactly one defect per file
— the Rust validator stops at the first error, the JS rule collects them all.
