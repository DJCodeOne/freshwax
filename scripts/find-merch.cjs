// scripts/find-merch.cjs
// Find merch products by name pattern via Firestore REST API
// Usage: node scripts/find-merch.cjs <search-term>

const PROJECT_ID = 'freshwax-store';
const searchTerm = (process.argv[2] || '').toLowerCase();

if (!searchTerm) {
  console.log('Usage: node scripts/find-merch.cjs <search-term>');
  process.exit(1);
}

async function findMerch() {
  let allDocs = [];
  let pageToken = null;

  do {
    let url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/merch?pageSize=300`;
    if (pageToken) url += `&pageToken=${pageToken}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.documents) {
      allDocs = allDocs.concat(data.documents);
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  console.log(`Searched ${allDocs.length} merch products for "${searchTerm}":\n`);

  let found = 0;
  allDocs.forEach(doc => {
    const fields = doc.fields || {};
    const name = (fields.name?.stringValue || '').toLowerCase();
    if (name.includes(searchTerm)) {
      found++;
      const id = doc.name.split('/').pop();
      const colors = fields.colorList?.arrayValue?.values?.map(v => v.stringValue) || [];
      console.log(`ID: ${id}`);
      console.log(`Name: ${fields.name?.stringValue}`);
      console.log(`Category: ${fields.categoryName?.stringValue || 'N/A'}`);
      console.log(`Colors: ${colors.join(', ') || 'N/A'}`);
      console.log(`Published: ${fields.published?.booleanValue}`);
      console.log(`Stock: ${fields.totalStock?.integerValue || 0}`);
      console.log('---');
    }
  });

  if (found === 0) {
    console.log('No matching products found.');
  }
}

findMerch().catch(e => { console.error(e); process.exit(1); });
