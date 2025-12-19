# Fresh Wax Development Notes

## Merch Section - Future Enhancements

When ready to enhance the merch section, consider implementing these features:

### Search & Discovery
- [ ] Product search with filters (category, price range, size)
- [ ] "Recently Viewed" items section
- [ ] "Recommended for You" based on browse/purchase history
- [ ] Related products on item pages

### User Experience
- [ ] Wishlist / Save for Later functionality
- [ ] Better empty state messaging (cart, orders, etc.)
- [ ] Improved mobile navigation with category quick-links
- [ ] Product reviews and ratings system

### Seller Features
- [ ] Streamlined artist/seller onboarding flow
- [ ] Artist sales dashboard with charts/analytics
- [ ] Inventory low-stock alerts
- [ ] Bulk product upload

### Notifications
- [ ] Order status email notifications
- [ ] Back-in-stock alerts for wishlist items
- [ ] Price drop notifications

### Social
- [ ] Social sharing buttons for products
- [ ] Share to Instagram/Twitter/Facebook

---

## Completed Enhancements

### December 2025

#### Admin Dashboard Fixes (Dec 19)
**Problem:** Save buttons in User Management and Partner Management showed "updated" but didn't actually save changes. Firestore security rules blocked client-side SDK updates.

**Solution:** Created server-side API endpoints to bypass Firestore rules:

1. **`/api/admin/update-user.ts`** (NEW)
   - Server-side user updates bypassing Firestore rules
   - Only updates fields that are explicitly provided
   - Updates customers, users, and artists collections as needed

2. **`/api/admin/delete-user.ts`** (NEW)
   - Soft-delete approach (sets `deleted: true` flag)
   - Updates all three collections

3. **`/api/admin/update-partner.ts`** (REWRITTEN)
   - Simplified updates format
   - Only updates Firestore-allowed fields
   - Creates customers record when downgrading partner

4. **`/api/admin/list-users.ts` & `list-partners.ts`**
   - Added soft-delete filtering: `if (doc.deleted === true) continue;`

5. **`src/pages/admin/users.astro`**
   - Removed client-side Firestore SDK
   - Now calls `/api/admin/update-user` API

6. **`src/pages/admin/artists/manage.astro`**
   - Removed client-side Firestore SDK
   - Removed failing `/api/roles/manage` dependency
   - Now calls `/api/admin/update-partner`

**Role System Clarification:**
- Customer + DJ roles: Auto-granted on registration
- Artist + Merch roles: Require admin approval
- Downgrading partner (removing artist/merch) moves them to User Management
- DJ role enables mix uploads and live streaming

**Status:** ✅ All fixes deployed and tested

---

#### Previous Fixes
- [x] DJ Lobby bypass system fixes
- [x] Access code redemption fixes
- [x] Forgot Password page
- [x] Admin Monitor Card (health checks, livestream preview, stats)
- [x] Health Check API endpoint
- [x] Firestore security rules updates
