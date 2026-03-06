// scripts/find-merch-detail.cjs
// Get detailed info on specific merch products by ID

const PROJECT_ID = 'freshwax-store';
const ids = process.argv.slice(2);

if (ids.length === 0) {
  console.log('Usage: node scripts/find-merch-detail.cjs <id1> <id2> ...');
  process.exit(1);
}

async function getDetail(id) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/merch/${id}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.error) {
    console.log(`${id}: ERROR - ${data.error.message}`);
    return;
  }

  const f = data.fields || {};
  console.log(`\nID: ${id}`);
  console.log(`Name: ${f.name?.stringValue}`);
  console.log(`Category: ${f.categoryName?.stringValue}`);

  // Colors from colorList
  const colors = f.colorList?.arrayValue?.values?.map(v => v.stringValue) || [];
  console.log(`Colors: ${colors.join(', ') || 'none'}`);

  // Colors from colorNames
  const colorNames = f.colorNames?.arrayValue?.values?.map(v => v.stringValue) || [];
  if (colorNames.length > 0) console.log(`Color Names: ${colorNames.join(', ')}`);

  // Variant stock
  const vs = f.variantStock?.mapValue?.fields;
  if (vs) {
    console.log('Variant Stock:');
    Object.keys(vs).forEach(k => {
      const inner = vs[k]?.mapValue?.fields;
      if (inner) {
        const stock = inner.stock?.integerValue || inner.quantity?.integerValue || '?';
        console.log(`  ${k}: ${stock}`);
      } else {
        console.log(`  ${k}: ${JSON.stringify(vs[k])}`);
      }
    });
  }

  console.log(`Total Stock: ${f.totalStock?.integerValue || 0}`);
  console.log(`Published: ${f.published?.booleanValue}`);
  console.log(`Price: ${f.retailPrice?.doubleValue || f.retailPrice?.integerValue || '?'}`);
  console.log('---');
}

Promise.all(ids.map(getDetail)).catch(e => { console.error(e); process.exit(1); });
