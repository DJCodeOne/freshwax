// Temporary debug endpoint to inspect merch collection
import type { APIRoute } from 'astro';
import { queryCollection, getDocument } from '../../lib/firebase-rest';

export const GET: APIRoute = async ({ url }) => {
  const partnerId = url.searchParams.get('partnerId') || '8WmxYeCp4PSym5iWHahgizokn5F2';

  // Get all merch items (limit 10)
  const allMerch = await queryCollection('merch', { limit: 10 });

  // Get partner doc
  const partner = await getDocument('artists', partnerId);

  // Check merch-suppliers doc
  let merchSupplierDoc = null;
  try {
    merchSupplierDoc = await getDocument('merch-suppliers', partnerId);
  } catch (e) {
    // ignore
  }

  // Show sample merch item fields
  const sampleFields = allMerch.length > 0
    ? Object.keys(allMerch[0])
    : [];

  return new Response(JSON.stringify({
    partnerId,
    partnerArtistName: partner?.artistName,
    merchCount: allMerch.length,
    sampleFields,
    sampleMerch: allMerch.slice(0, 3).map(m => ({
      id: m.id,
      name: m.name,
      supplierId: m.supplierId,
      supplierName: m.supplierName,
      supplier: m.supplier,
      vendorId: m.vendorId,
      vendorName: m.vendorName,
    })),
    merchSupplierDoc
  }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
