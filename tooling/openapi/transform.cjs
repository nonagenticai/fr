// orval input transformer, applied to every snapshot before generation.
//
// An HTTP header value is a string or absent; it is never JSON null. FastAPI
// emits an optional header parameter (`Optional[str] = Header(None)`) as
// `anyOf: [{type: string}, {type: null}]`, and orval's fetch client then types
// it `string | null` and spreads it into `RequestInit.headers`, which does not
// typecheck. Normalise every header parameter's schema to its non-null branch.
// The snapshot on disk is untouched; only orval's in-memory copy is.
module.exports = (spec) => {
  for (const item of Object.values(spec.paths || {})) {
    for (const op of Object.values(item || {})) {
      if (!op || typeof op !== 'object' || !Array.isArray(op.parameters)) continue;
      for (const p of op.parameters) {
        if (p && p.in === 'header' && p.schema && Array.isArray(p.schema.anyOf)) {
          const nonNull = p.schema.anyOf.filter((s) => !(s && s.type === 'null'));
          if (nonNull.length === 1) {
            const { anyOf: _drop, ...rest } = p.schema;
            p.schema = { ...rest, ...nonNull[0] };
          }
        }
      }
    }
  }
  return spec;
};
