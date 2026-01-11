// scripts/fix-srs-order.js
// Run with: node scripts/fix-srs-order.js
// Requires ADMIN_KEY environment variable

const ADMIN_KEY = process.env.ADMIN_KEY;
const ORDER_ID = 'order_1768158963_osoj60u4';
const ARTIST_ID = 'JueT7q9eKjQk4iFRg2tXa4ZP8642'; // Max's userId
const ARTIST_EMAIL = 'undergroundlair.23@gmail.com';
const ARTIST_NAME = 'Dark Dusk';

async function main() {
  if (!ADMIN_KEY) {
    console.error('Error: ADMIN_KEY environment variable required');
    console.error('Run: set ADMIN_KEY=your_key && node scripts/fix-srs-order.js');
    process.exit(1);
  }

  console.log('1. Updating order with correct fees...');

  // Update order with correct PayPal fees
  const updateRes = await fetch('https://freshwax.co.uk/api/admin/update-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderId: ORDER_ID,
      key: ADMIN_KEY,
      updates: {
        paymentMethod: 'paypal',
        totals: {
          subtotal: 2.00,
          shipping: 0,
          freshWaxFee: 0.02,
          paymentProcessingFee: 0.36,
          serviceFees: 0.38,
          total: 2.00
        }
      }
    })
  });

  const updateResult = await updateRes.json();
  console.log('Order update result:', updateResult);

  if (!updateResult.success) {
    console.error('Failed to update order');
    process.exit(1);
  }

  console.log('\n2. Creating pending payout for Max...');

  // Artist earnings: £2.00 - £0.02 (FW fee) - £0.36 (PayPal fee) = £1.62
  const artistEarnings = 1.62;

  // Create pending payout record
  const payoutRes = await fetch('https://freshwax.co.uk/api/admin/record-payout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: ADMIN_KEY,
      artistId: ARTIST_ID,
      artistName: ARTIST_NAME,
      artistEmail: ARTIST_EMAIL,
      orderId: ORDER_ID,
      orderNumber: 'FW-260111-SRS001',
      amount: artistEarnings,
      itemAmount: artistEarnings,
      currency: 'gbp',
      status: 'pending',
      payoutMethod: null, // Artist hasn't connected payment yet
      notes: 'SRS - When Worlds Collide EP (2 tracks @ £1.00 each)'
    })
  });

  const payoutResult = await payoutRes.json();
  console.log('Payout record result:', payoutResult);

  console.log('\n3. Done! Max should see £1.62 pending in his dashboard.');
  console.log('   To send artist notification email, run resend-confirmation endpoint.');
}

main().catch(console.error);
