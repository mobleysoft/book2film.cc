const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
export const schemas = {
  summary: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: text(650) } },
  treatment: { type: 'object', additionalProperties: false, required: ['title', 'logline', 'scenes'], properties: {
    title: text(160), logline: text(600), scenes: { type: 'array', minItems: 12, maxItems: 12, items: {
      type: 'object', additionalProperties: false, required: ['scene_number', 'description', 'source_pages', 'adaptation_notes'],
      properties: { scene_number: { type: 'integer', minimum: 1, maximum: 12 }, description: text(400), adaptation_notes: text(240),
        source_pages: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'integer', minimum: 1, maximum: 120 } } },
    } },
  } },
};
