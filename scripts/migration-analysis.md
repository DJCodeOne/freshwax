# Customers to Users Migration Analysis

## Collection Schema Summary

### SHARED FIELDS (16) - Exist in both, users takes precedence
- uid, email, displayName, displayNameLower, name, phone
- roles, permissions, suspended, approved, deleted, deletedAt
- createdAt, updatedAt
- isAdmin, isArtist

### USERS-ONLY FIELDS (21) - Keep as-is
- Authentication: provider, emailVerified
- Roles: pendingRoles, role
- Payments: paypalEmail, paypalLinkedAt, payoutMethod
- Stripe: stripeConnectId, stripeConnectStatus, stripeChargesEnabled, stripePayoutsEnabled, stripeDetailsSubmitted, stripeLastUpdated
- Subscription: subscription
- Partner: partnerInfo
- DJ Access: go-liveBypassed, bypassedAt, bypassedBy, quickAccessCode
- Other: artistName, disabled

### CUSTOMERS-ONLY FIELDS (22) - Need to migrate to users
- Address: address1, address2, city, county, postcode, country, address (map)
- Profile: firstName, lastName, fullName
- Avatar: avatarUrl, avatarUpdatedAt
- Wishlist: wishlist, wishlistUpdatedAt
- Following: followedArtists, followedArtistsUpdatedAt
- Legacy roles: isDJ, isMerchSupplier, isVinylSeller
- Admin: adminNotes, deletedBy, id

---

## Files to Update (Categorized)

### CATEGORY 1: Registration/Auth (CREATE operations)
| File | Line | Operation | Complexity |
|------|------|-----------|------------|
| register.astro | 1052, 1233 | setDoc customers | MEDIUM - Remove duplicate write |
| login.astro | 308 | setDoc customers | MEDIUM - Remove duplicate write |

### CATEGORY 2: Profile Management (READ + WRITE)
| File | Line | Operation | Complexity |
|------|------|-----------|------------|
| account/dashboard.astro | 741, 1886 | getDoc, setDoc | HIGH - Main profile page |
| checkout.astro | 185, 982 | getDoc, setDoc | HIGH - Address handling |
| upload-avatar.ts | 176, 268 | setDocument | LOW - Change collection name |

### CATEGORY 3: Wishlist/Following (READ + WRITE)
| File | Line | Operation | Complexity |
|------|------|-----------|------------|
| wishlist.ts | 26, 129-212 | getDocument, updateDocument | LOW - Change collection name |
| follow-artist.ts | 32-257 | getDocument, updateDocument | LOW - Change collection name |

### CATEGORY 4: Gift Cards/Credits (READ + WRITE)
| File | Line | Operation | Complexity |
|------|------|-----------|------------|
| giftcards/redeem.ts | 174 | updateDocument | LOW |
| giftcards/balance.ts | 142 | updateDocument | LOW |
| giftcards/credit-account.ts | 91 | updateDocument | LOW |
| giftcards/purchase.ts | 303 | getDocument | LOW |
| giftcards/purchased.ts | 19 | getDocument | LOW |
| admin/giftcards.ts | 179, 357 | getDocument, updateDocument | LOW |

### CATEGORY 5: Orders (READ)
| File | Line | Operation | Complexity |
|------|------|-----------|------------|
| create-order.ts | 77, 599-601 | getDocument, updateDocument | MEDIUM - Address reading |
| process-order.ts | 394-396 | getDocument, updateDocument | MEDIUM |
| admin/orders.astro | 25 | getDocument | LOW |
| order-utils.ts | 620-622 | getDocument, updateDocument | LOW |
| payment/status.ts | 54 | getDocument | LOW |

### CATEGORY 6: Admin Operations (READ + WRITE)
| File | Line | Operation | Complexity |
|------|------|-----------|------------|
| admin/update-user.ts | 57, 81 | getDocument, updateDocument | MEDIUM - Sync logic |
| admin/update-partner.ts | 145-173 | getDocument, updateDocument, setDocument | HIGH |
| admin/delete-user.ts | 65-67 | getDocument, updateDocument | LOW |
| admin/list-partners.ts | 50 | queryCollection | MEDIUM - Query both |
| admin/lobby-bypass.ts | 110 | queryCollection | LOW |
| admin/export-analytics.ts | 201 | case 'customers' | LOW |
| admin/dj-moderation.ts | 125 | queryCollection | LOW |
| admin/vinyl/index.astro | 23 | queryCollection | LOW |
| roles/manage.ts | 217-460 | getDocument, updateDocument, setDocument | HIGH |

### CATEGORY 7: User Type/Profile Fetch (READ)
| File | Line | Operation | Complexity |
|------|------|-----------|------------|
| get-user-type.ts | 38 | getDocument | MEDIUM - Primary auth check |
| get-dj-mixes.ts | 73 | getDocument | LOW |

### CATEGORY 8: DJ/Artist Operations (READ)
| File | Line | Operation | Complexity |
|------|------|-----------|------------|
| artist/dashboard.astro | 109 | getDocument | LOW |
| artist/account.astro | 42 | getDocument | LOW |
| stream/dj-settings.ts | 42 | queryCollection | LOW |
| mix/finalize-upload.ts | 102 | getDocument | LOW |
| upload-mix.ts | 102 | getDocument | LOW |

### CATEGORY 9: Account Management (WRITE)
| File | Line | Operation | Complexity |
|------|------|-----------|------------|
| delete-account.ts | 85-87 | getDocument, updateDocument | LOW |
| profile-sync.ts | - | Sync customers->users | DELETE THIS FILE |

### CATEGORY 10: Utility/Cache
| File | Line | Operation | Complexity |
|------|------|-----------|------------|
| firebase-rest.ts | 736 | clearCache | LOW - Remove line |

---

## Migration Complexity Summary

| Complexity | Count | Files |
|------------|-------|-------|
| HIGH | 4 | dashboard.astro, checkout.astro, update-partner.ts, roles/manage.ts |
| MEDIUM | 6 | register.astro, login.astro, update-user.ts, list-partners.ts, get-user-type.ts, create-order.ts |
| LOW | 21 | All others |
| DELETE | 1 | profile-sync.ts (no longer needed) |

---

## Migration Steps

### PHASE 1: Data Migration
1. Backup both collections
2. For each customer document:
   - Get corresponding user document
   - Merge customer-only fields into user document
   - Verify merged data

### PHASE 2: Code Updates (in order)
1. Update firebase-rest.ts (cache)
2. Update registration flow (register.astro, login.astro)
3. Update profile management (dashboard.astro, checkout.astro)
4. Update all API endpoints (change 'customers' -> 'users')
5. Delete profile-sync.ts
6. Update admin pages

### PHASE 3: Testing
1. Test registration (new user creation)
2. Test login (existing user)
3. Test profile update (address, avatar)
4. Test checkout (address prefill)
5. Test wishlist add/remove
6. Test follow artist
7. Test gift card operations
8. Test order creation
9. Test admin user management
10. Test artist dashboard

### PHASE 4: Cleanup
1. Export final customers collection backup
2. Delete customers collection documents
3. Remove customers from backup script

---

## Field Conflict Analysis

### Conflicts Found (14 total)
Most are just `updatedAt` timestamp differences (expected). Only 2 real conflicts:

| User | Field | Users Value | Customers Value | Resolution |
|------|-------|-------------|-----------------|------------|
| davidhagon@gmail.com | name | Dave Hagon | Code One | Keep "Dave Hagon" (real name) |
| david@chilterncomputers.net | displayName | Bob Fresh | Dave | Keep "Bob Fresh" (users is authoritative) |

### Conflict Resolution Strategy
- **updatedAt**: Use the more recent timestamp
- **All other shared fields**: Users collection takes precedence (has auth/role data)
- **Customer-only fields**: Migrate directly (no conflict possible)

---

## Merged Users Schema (Final)

```typescript
interface MergedUser {
  // === Identity (from both, users takes precedence) ===
  uid: string;
  email: string;
  displayName: string;
  displayNameLower: string;
  name?: string;

  // === Profile (migrated from customers) ===
  firstName?: string;
  lastName?: string;
  fullName?: string;
  phone?: string;

  // === Address (migrated from customers) ===
  address1?: string;
  address2?: string;
  city?: string;
  county?: string;
  postcode?: string;
  country?: string;

  // === Avatar (migrated from customers) ===
  avatarUrl?: string;
  avatarUpdatedAt?: string;

  // === Wishlist (migrated from customers) ===
  wishlist?: string[];
  wishlistUpdatedAt?: string;

  // === Following (migrated from customers) ===
  followedArtists?: string[];
  followedArtistsUpdatedAt?: string;

  // === Authentication (users only) ===
  provider: string;
  emailVerified: boolean;

  // === Roles (users only - structured) ===
  roles: {
    customer: boolean;
    admin?: boolean;
    artist?: boolean;
    djEligible?: boolean;
    merchSeller?: boolean;
    vinylSeller?: boolean;
  };
  pendingRoles?: {...};

  // === Subscription (users only) ===
  subscription?: {
    tier: string;
    startedAt: string;
    expiresAt: string;
    source?: string;
  };

  // === Payment/Partner (users only) ===
  payoutMethod?: string;
  paypalEmail?: string;
  paypalLinkedAt?: string;
  stripeConnectId?: string;
  stripeConnectStatus?: string;
  partnerInfo?: {...};

  // === DJ Access (users only) ===
  go-liveBypassed?: boolean;
  bypassedAt?: string;
  bypassedBy?: string;
  quickAccessCode?: string;

  // === Account Status ===
  suspended?: boolean;
  deleted?: boolean;
  deletedAt?: string;
  deletedBy?: string;
  adminNotes?: string;

  // === Timestamps ===
  createdAt: Timestamp;
  updatedAt: string;
}
```

---

## Rollback Plan
1. Keep customers collection backup for 30 days
2. If issues found, restore customers documents
3. Revert code changes via git

---

## Pre-Migration Checklist
- [ ] Full Firebase backup completed
- [ ] Git branch created for migration
- [ ] Local development tested
- [ ] All 44 files identified and mapped
- [ ] Conflict resolution strategy agreed

## Post-Migration Verification
- [ ] All 20 users have merged data
- [ ] Registration creates single document
- [ ] Profile updates work
- [ ] Checkout address prefills
- [ ] Wishlist operations work
- [ ] Order creation works
- [ ] Admin functions work
- [ ] No 'customers' references in code
