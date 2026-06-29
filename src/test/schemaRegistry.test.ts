import assert from "assert/strict";
import { SchemaRegistry } from "../kernel/schemaRegistry";

suite("SchemaRegistry", () => {
  test("registers, gets, and lists code-defined schemas", () => {
    const registry = new SchemaRegistry();
    const schema = { id: "projectManifest", version: "0.0.0" };

    registry.register(schema);

    assert.equal(registry.get("projectManifest", "0.0.0"), schema);
    assert.equal(registry.get("projectManifest", "1.0.0"), undefined);
    assert.deepEqual(registry.list(), [schema]);
  });

  test("unregisters schemas through registration disposables", () => {
    const registry = new SchemaRegistry();
    const schema = { id: "capability.schema", version: "0.0.0" };
    const first = registry.register(schema);
    const second = registry.register(schema);

    first.dispose();
    assert.equal(registry.get("capability.schema", "0.0.0"), schema);

    second.dispose();
    assert.equal(registry.get("capability.schema", "0.0.0"), undefined);
  });
});
