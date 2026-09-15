import type { JsonSchema, OpenApiDocument } from '../../types';
import { resolveSchema, schemaFields } from './apiDocsModel';

interface SchemaFieldsTableProps {
  doc: OpenApiDocument;
  schema: JsonSchema | undefined;
  /** Shown when the schema has no properties (e.g. a tool without arguments). */
  emptyLabel?: string;
}

/**
 * The fields of an object schema as a table, straight from the generated JSON
 * Schema. Deeply structured fields (agent configs, workflow columns…) are
 * summarised by type; the full schema stays one click away.
 */
export default function SchemaFieldsTable({
  doc,
  schema,
  emptyLabel = 'No parameters.',
}: SchemaFieldsTableProps) {
  const fields = schemaFields(doc, schema);
  if (fields.length === 0) return <p className="text-xs text-dark-500">{emptyLabel}</p>;
  const hasNested = fields.some(f => f.nested);

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto border border-dark-700 rounded-lg">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-dark-800/80 text-dark-400 text-left">
              <th className="px-3 py-2 font-medium">Field</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {fields.map(field => (
              <tr key={field.name} className="border-t border-dark-700/70 align-top">
                <td className="px-3 py-2 whitespace-nowrap">
                  <code className="font-mono text-dark-100">{field.name}</code>
                  {field.required && (
                    <span className="ml-1.5 text-[10px] font-medium text-rose-300">required</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <code className="font-mono text-indigo-300 break-words">{field.type}</code>
                </td>
                <td className="px-3 py-2 text-dark-300">
                  {field.description || <span className="text-dark-500">—</span>}
                  {field.constraints.length > 0 && (
                    <div className="mt-0.5 text-[11px] text-dark-500">
                      {field.constraints.join(' · ')}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasNested && (
        <details className="text-xs">
          <summary className="cursor-pointer text-dark-400 hover:text-dark-200 select-none">
            Full JSON Schema
          </summary>
          <pre className="mt-2 bg-dark-950/60 border border-dark-700 rounded-lg p-3 font-mono text-[11px] text-dark-300 overflow-x-auto max-h-80">
            {JSON.stringify(resolveSchema(doc, schema), null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
