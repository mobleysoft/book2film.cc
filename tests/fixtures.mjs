export function pdfFixture() {
  const text = [
    'THE LAST LIGHT - A SHORT ORIGINAL TEST MANUSCRIPT',
    'Mara keeps the lighthouse on an island after a storm cuts the power.',
    'Her brother Eli arrives with a damaged battery and a warning.',
    'A fishing boat is lost in the fog. The harbor radio is silent.',
    'Mara wants to wait for help. Eli wants to climb the tower now.',
    'They argue about the night their father vanished at sea.',
    'Mara finds his repair notes beneath a loose floorboard.',
    'The notes show how to connect the battery to the old lamp.',
    'Eli climbs the tower while Mara repairs the broken switch.',
    'The wind breaks a window. Eli drops the battery cable.',
    'Mara reaches him and they fasten the cable together.',
    'The lamp turns. A distant boat answers with three flashes.',
    'At dawn the boat reaches harbor. The siblings stay to repair the light.',
  ];
  const stream = `BT /F1 12 Tf 40 750 Td 22 TL ${text.map(t => `(${t}) Tj T*`).join('\n')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let content = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(content)); content += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(content);
  content += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}
export const treatment = () => ({ title: 'The Last Light', logline: 'Two siblings repair a lighthouse to rescue a stranded boat.',
  scenes: Array.from({ length: 12 }, (_, i) => ({ scene_number: i + 1, description: `Mara and Eli work on the lighthouse: beat ${i + 1}.`, source_pages: [1], adaptation_notes: 'Proposed expansion for editorial review.' })) });
