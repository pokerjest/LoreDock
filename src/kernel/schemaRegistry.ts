export interface RegisteredSchema {
  id: string;
  version: string;
}

interface SchemaRegistration {
  schema: RegisteredSchema;
  references: number;
}

export class SchemaRegistry {
  private readonly schemas = new Map<string, SchemaRegistration>();

  public register(schema: RegisteredSchema): { dispose(): void } {
    const key = schemaKey(schema.id, schema.version);
    const existing = this.schemas.get(key);

    if (existing) {
      existing.references += 1;
    } else {
      this.schemas.set(key, { schema, references: 1 });
    }

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }

        disposed = true;
        const current = this.schemas.get(key);
        if (!current) {
          return;
        }

        current.references -= 1;
        if (current.references <= 0) {
          this.schemas.delete(key);
        }
      }
    };
  }

  public get(id: string, version: string): RegisteredSchema | undefined {
    return this.schemas.get(schemaKey(id, version))?.schema;
  }

  public list(): RegisteredSchema[] {
    return [...this.schemas.values()].map((entry) => entry.schema);
  }
}

function schemaKey(id: string, version: string): string {
  return `${id}@${version}`;
}
