// Dashboard — subscription module
// Handles Plus subscription, badge selector, referral codes,
// promo codes, Stripe/PayPal payment flows, Go Plus modal

var ctx = null;

export function init(context) {
  ctx = context;
}

// Load subscription status and update UI
export async function loadSubscriptionStatus(userId) {
  try {
    // Get auth token for authenticated API call
    var currentUser = ctx.getCurrentUser();
    var idToken = currentUser ? await currentUser.getIdToken() : null;

    var response = await fetch('/api/subscription/?userId=' + userId, {
      headers: idToken ? { 'Authorization': 'Bearer ' + idToken } : {}
    });
    var result = await response.json();

    if (!result.success) {
      console.warn('[Subscription] API failed:', result.error);
      return;
    }

    var tierBadge = document.querySelector('#subscriptionTier .tier-badge');
    var tierName = document.querySelector('#subscriptionTier .tier-name');
    var upgradeSection = document.getElementById('subscriptionUpgrade');
    var proSection = document.getElementById('subscriptionPro');
    var proExpires = document.getElementById('proExpires');
    var goPlusHeaderBtn = document.getElementById('goPlusHeaderBtn');

    // Update tier badge
    if (result.subscription.isPro) {
      tierBadge.textContent = 'Plus';
      tierBadge.classList.remove('free');
      tierBadge.classList.add('plus');
      tierName.textContent = 'Member';

      // Show pro section, hide upgrade
      if (upgradeSection) upgradeSection.classList.add('hidden');
      if (proSection) proSection.classList.remove('hidden');

      // Hide Go Plus header button for Plus members
      if (goPlusHeaderBtn) goPlusHeaderBtn.classList.add('hidden');

      // Show Plus badge selector
      var plusBadgeSection = document.getElementById('plusBadgeSection');
      if (plusBadgeSection) {
        plusBadgeSection.classList.remove('hidden');
        initBadgeSelector(userId);
      }

      // Show expiry date
      if (proExpires && result.subscription.expiresAt) {
        var expDate = new Date(result.subscription.expiresAt);
        proExpires.textContent = 'Your Plus membership expires on ' + expDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      }

      // Load referral code
      loadReferralCode(userId);

      // Load Plus stats (playlist count and skip count)
      loadPlusStats(userId);

      // Show and set up toggle for Plus member modal
      var tierToggleBtn = document.getElementById('tierToggleBtn');
      var plusMemberModal = document.getElementById('plusMemberModal');
      if (tierToggleBtn && plusMemberModal) {
        tierToggleBtn.classList.remove('hidden');
        tierToggleBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          plusMemberModal.classList.remove('hidden');
          document.body.style.overflow = 'hidden';
        });

        // Close modal on backdrop click
        plusMemberModal.addEventListener('click', function(e) {
          if (e.target === plusMemberModal) {
            plusMemberModal.classList.add('hidden');
            document.body.style.overflow = '';
          }
        });

        // Close modal on X button click
        document.getElementById('plusMemberModalCloseBtn')?.addEventListener('click', function() {
          plusMemberModal.classList.add('hidden');
          document.body.style.overflow = '';
        });
      }
    } else {
      tierBadge.textContent = 'Standard';
      tierBadge.classList.add('free');
      tierBadge.classList.remove('plus');
      tierName.textContent = 'Account';

      // Show upgrade section, hide pro
      if (upgradeSection) upgradeSection.classList.remove('hidden');
      if (proSection) proSection.classList.add('hidden');

      // Check if expired Plus user - show special renewal message
      if (result.subscription.wasPlus && result.subscription.isExpired) {
        var upgradeTitle = document.querySelector('.upgrade-title');
        var upgradeSubtitle = document.querySelector('.upgrade-subtitle');
        if (upgradeTitle) upgradeTitle.textContent = 'Renew Your Plus Membership';
        if (upgradeSubtitle) upgradeSubtitle.textContent = 'Your Plus subscription has expired. Renew now to restore your benefits!';

        // Change button text
        if (goPlusHeaderBtn) {
          var btnText = goPlusHeaderBtn.querySelector('.pro-text');
          if (btnText) btnText.textContent = 'Renew Plus';
        }

        // Show Plus ID if available
        if (result.subscription.plusId && proExpires) {
          proExpires.textContent = 'Your Plus ID: ' + result.subscription.plusId + ' (expired)';
          proExpires.style.color = '#ef4444';
        }
      }

      // Show Go Plus header button for non-Plus users
      if (goPlusHeaderBtn) goPlusHeaderBtn.classList.remove('hidden');
    }

    // Check for expiring soon warning (for active Plus users)
    if (result.subscription.isPro && result.subscription.isExpiringSoon) {
      var expiryWarning = document.createElement('div');
      expiryWarning.className = 'expiry-warning';
      expiryWarning.innerHTML =
        '<span class="warning-icon">⚠️</span>' +
        '<span>Your Plus membership expires soon! <button type="button" id="renewPlusLink" style="background:none;border:none;padding:0;color:inherit;font:inherit;cursor:pointer;text-decoration:underline;">Renew now</button></span>';
      if (proExpires && proExpires.parentNode) {
        proExpires.parentNode.insertBefore(expiryWarning, proExpires.nextSibling);
      }
      document.getElementById('renewPlusLink')?.addEventListener('click', function(e) {
        e.preventDefault();
        document.getElementById('goPlusModal')?.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
      });
    }

    // Update usage stats
    var mixUploadsUsed = document.getElementById('mixUploadsUsed');
    var mixUploadsLimit = document.getElementById('mixUploadsLimit');
    var streamTimeUsed = document.getElementById('streamTimeUsed');
    var streamTimeLimit = document.getElementById('streamTimeLimit');

    if (mixUploadsUsed) mixUploadsUsed.textContent = result.usage.mixUploadsThisWeek;
    if (mixUploadsLimit) mixUploadsLimit.textContent = result.limits.mixUploadsPerWeek === 'unlimited' ? '∞' : result.limits.mixUploadsPerWeek;
    if (streamTimeUsed) streamTimeUsed.textContent = Math.floor(result.usage.streamMinutesToday / 60);
    if (streamTimeLimit) streamTimeLimit.textContent = result.limits.streamHoursPerDay;

  } catch (error) {
    console.error('Error loading subscription:', error);
  }
}

// Load and display referral code for Pro users (from KV storage)
async function loadReferralCode(userId) {
  try {
    // Fetch referral code from KV-based API
    var token = await ctx.auth.currentUser?.getIdToken();
    var response = await fetch('/api/get-referral-code/?userId=' + userId, {
      headers: token ? { 'Authorization': 'Bearer ' + token } : {}
    });
    var data = await response.json();

    var referralCodeDisplay = document.getElementById('referralCodeDisplay');
    var copyReferralBtn = document.getElementById('copyReferralBtn');
    var referralNote = document.getElementById('referralNote');
    var referralExpires = document.getElementById('referralExpires');
    var referralUsed = document.getElementById('referralUsed');
    var referralSection = document.getElementById('referralSection');

    if (!referralSection) {
      return;
    }

    // Check if code has been used (from KV data)
    var isUsed = data.hasCode && data.data && data.data.usedCount >= data.data.maxUses;

    if (isUsed) {
      // Code was used - show it directly (no animation needed)
      referralCodeDisplay.textContent = data.code;
      referralNote.classList.add('hidden');
      referralUsed.classList.remove('hidden');
      copyReferralBtn.style.display = 'none';
    } else {
      // Either no code yet OR code exists but not used - always show "Generate/Reveal" button
      var hasExistingCode = data.hasCode && data.code;
      referralCodeDisplay.textContent = hasExistingCode ? 'Reveal Your Code' : 'Generate Code';
      referralCodeDisplay.style.cursor = 'pointer';
      referralNote.textContent = hasExistingCode
        ? 'Click to reveal your exclusive referral code'
        : 'Click to generate your unique referral code';
      copyReferralBtn.style.display = 'none';

      // Helper function to animate code reveal
      var animateCodeReveal = function(code) {
        referralCodeDisplay.textContent = '';
        referralCodeDisplay.style.cursor = 'default';
        referralCodeDisplay.classList.add('code-generating');

        // Add glow animation styles
        referralCodeDisplay.style.animation = 'none';
        referralCodeDisplay.offsetHeight; // Trigger reflow
        referralCodeDisplay.style.animation = 'codeReveal 0.5s ease-out forwards, codeGlow 2s ease-in-out infinite';
        referralCodeDisplay.style.textShadow = '0 0 10px #22c55e, 0 0 20px #22c55e, 0 0 30px #22c55e';

        // Typewriter effect
        var i = 0;
        var typeWriter = function() {
          if (i < code.length) {
            referralCodeDisplay.textContent += code.charAt(i);
            i++;
            ctx.setTypewriterTimeout(setTimeout(typeWriter, 80));
          } else {
            // Code fully revealed - show celebration
            referralCodeDisplay.classList.remove('code-generating');
            referralCodeDisplay.classList.add('code-revealed');
            ctx.setTypewriterTimeout(setTimeout(function() {
              referralCodeDisplay.style.animation = 'codeGlow 3s ease-in-out infinite';
              ctx.setTypewriterTimeout(null);
            }, 500));
          }
        };
        ctx.setTypewriterTimeout(setTimeout(typeWriter, 300));

        referralNote.innerHTML = '<span style="color: #22c55e;">Your exclusive, one-time use discount code is ready!</span>';
        copyReferralBtn.style.display = 'flex';
        copyReferralBtn.style.animation = 'fadeIn 0.5s ease-out 1s forwards';
        copyReferralBtn.style.opacity = '0';
        referralExpires.style.display = 'block';
        referralExpires.style.animation = 'fadeIn 0.5s ease-out 1.2s forwards';
        referralExpires.style.opacity = '0';

        // Set up copy button
        copyReferralBtn.addEventListener('click', function() {
          navigator.clipboard.writeText(code).then(function() {
            copyReferralBtn.classList.add('copied');
            copyReferralBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
            setTimeout(function() {
              copyReferralBtn.classList.remove('copied');
              copyReferralBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
            }, 2000);
          });
        });
      };

      // Make the code display clickable
      referralCodeDisplay.addEventListener('click', async function() {
        var currentText = referralCodeDisplay.textContent;
        if (currentText === 'Generating...' || currentText === 'Revealing...') return;

        if (hasExistingCode) {
          // Already have a code - just animate the reveal
          referralCodeDisplay.textContent = 'Revealing...';
          setTimeout(function() {
            animateCodeReveal(data.code);
          }, 300);
        } else {
          // Generate new code
          referralCodeDisplay.textContent = 'Generating...';
          try {
            // Get fresh auth token
            var user = ctx.auth.currentUser;
            var idToken = user ? await user.getIdToken() : null;

            var res = await fetch('/api/generate-referral-code/', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(idToken ? { 'Authorization': 'Bearer ' + idToken } : {})
              },
              body: JSON.stringify({ userId: userId })
            });
            var genResult = await res.json();

            if (genResult.success && genResult.code) {
              animateCodeReveal(genResult.code);
            } else {
              referralCodeDisplay.textContent = 'Click to retry';
              referralNote.textContent = genResult.error || 'Failed to generate code';
            }
          } catch (err) {
            referralCodeDisplay.textContent = 'Click to retry';
            referralNote.textContent = 'Error generating code';
          }
        }
      });
    }
  } catch (error) {
    console.error('Error loading referral code:', error);
    var referralCodeDisplay = document.getElementById('referralCodeDisplay');
    if (referralCodeDisplay) referralCodeDisplay.textContent = 'Error loading';
  }
}

// Load Plus stats (playlist count and skip usage)
async function loadPlusStats(userId) {
  try {
    var playlistUsageItem = document.getElementById('playlistUsageItem');
    var skipUsageItem = document.getElementById('skipUsageItem');
    var playlistCountEl = document.getElementById('playlistTrackCount');
    var playlistLimitEl = document.getElementById('playlistTrackLimit');
    var skipsUsedEl = document.getElementById('skipsUsed');
    var skipsLimitEl = document.getElementById('skipsLimit');

    // Show the Plus-only usage items
    if (playlistUsageItem) playlistUsageItem.classList.remove('hidden');
    if (skipUsageItem) skipUsageItem.classList.remove('hidden');

    // Fetch personal playlist count
    var playlistRes = await fetch('/api/playlist/personal/?userId=' + userId);
    var playlistData = await playlistRes.json();
    if (playlistData.success) {
      var count = playlistData.playlist?.length || 0;
      var limit = playlistData.trackLimit || 1000;
      if (playlistCountEl) playlistCountEl.textContent = count;
      if (playlistLimitEl) playlistLimitEl.textContent = limit;
    }

    // Fetch skip usage
    var skipRes = await fetch('/api/playlist/skip/?userId=' + userId);
    var skipData = await skipRes.json();
    if (skipData.success) {
      if (skipsUsedEl) skipsUsedEl.textContent = skipData.used || 0;
      if (skipsLimitEl) skipsLimitEl.textContent = skipData.limit || 3;
    }
  } catch (error) {
    console.error('[Dashboard] Error loading Plus stats:', error);
  }
}

// Badge emoji map for display
var BADGE_EMOJIS = {
  crown: '👑', fire: '🔥', headphones: '🎧', skull: '💀', lion: '🦁',
  leopard: '🐆', palm: '🌴', lightning: '⚡', vinyl: '💿', speaker: '🔊',
  moon: '🌙', star: '⭐', diamond: '💎', snake: '🐍', bat: '🦇',
  mic: '🎤', leaf: '🌿', gorilla: '🦍', spider: '🕷️', alien: '👽'
};

// Initialize Plus badge selector
async function initBadgeSelector(userId) {
  var badgeHeader = document.getElementById('badgeHeader');
  var badgeContent = document.getElementById('badgeContent');
  var badgeToggleBtn = document.getElementById('badgeToggleBtn');
  var currentBadgePreview = document.getElementById('currentBadgePreview');
  var badgeGrid = document.getElementById('badgeGrid');
  var saveBadgeBtn = document.getElementById('saveBadgeBtn');
  var badgeSaveStatus = document.getElementById('badgeSaveStatus');

  if (!badgeGrid || !saveBadgeBtn) return;

  // Set up collapsible toggle
  if (badgeHeader && badgeContent && badgeToggleBtn) {
    badgeHeader.addEventListener('click', function() {
      var isHidden = badgeContent.style.display === 'none';
      badgeContent.style.display = isHidden ? 'block' : 'none';
      badgeToggleBtn.classList.toggle('open', isHidden);
    });
  }

  var selectedBadge = 'crown'; // Default
  var savedBadge = 'crown';

  // Load user's current badge from KV
  try {
    var response = await fetch('/api/get-user-badge/?userId=' + userId);
    var data = await response.json();
    if (data.success && data.badge) {
      selectedBadge = data.badge;
      savedBadge = data.badge;
      // Update preview
      if (currentBadgePreview) {
        currentBadgePreview.textContent = BADGE_EMOJIS[data.badge] || '👑';
      }
    }
  } catch (err) {
    console.error('Error loading badge:', err);
  }

  // Mark the current badge as selected
  var updateSelection = function() {
    badgeGrid.querySelectorAll('.badge-option').forEach(function(btn) {
      btn.classList.toggle('selected', btn.dataset.badge === selectedBadge);
    });
    // Enable save button only if selection changed
    saveBadgeBtn.disabled = selectedBadge === savedBadge;
    badgeSaveStatus.textContent = '';
  };

  updateSelection();

  // Handle badge selection
  badgeGrid.addEventListener('click', function(e) {
    var btn = e.target.closest('.badge-option');
    if (btn) {
      selectedBadge = btn.dataset.badge;
      updateSelection();
    }
  });

  // Handle save
  saveBadgeBtn.addEventListener('click', async function() {
    saveBadgeBtn.disabled = true;
    badgeSaveStatus.textContent = 'Saving...';
    badgeSaveStatus.classList.remove('error');

    try {
      var user = ctx.auth.currentUser;
      var idToken = user ? await user.getIdToken() : null;

      var response = await fetch('/api/save-user-badge/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idToken ? { 'Authorization': 'Bearer ' + idToken } : {})
        },
        body: JSON.stringify({ userId: userId, badge: selectedBadge })
      });

      var result = await response.json();
      if (result.success) {
        savedBadge = selectedBadge;
        badgeSaveStatus.textContent = '✓ Badge saved!';
        saveBadgeBtn.disabled = true;

        // Update the preview emoji
        if (currentBadgePreview) {
          currentBadgePreview.textContent = BADGE_EMOJIS[selectedBadge] || '👑';
        }

        // Update localStorage cache so it's immediately reflected
        var cached = sessionStorage.getItem('fw_auth_cache');
        if (cached) {
          var cachedAuth = JSON.parse(cached);
          cachedAuth.plusBadge = selectedBadge;
          sessionStorage.setItem('fw_auth_cache', JSON.stringify(cachedAuth));
        }
      } else {
        badgeSaveStatus.textContent = result.error || 'Failed to save';
        badgeSaveStatus.classList.add('error');
        saveBadgeBtn.disabled = false;
      }
    } catch (err) {
      console.error('Error saving badge:', err);
      badgeSaveStatus.textContent = 'Error saving badge';
      badgeSaveStatus.classList.add('error');
      saveBadgeBtn.disabled = false;
    }
  });
}

// Handle promo code application for Plus upgrade
export async function handleApplyPromoCode() {
  var currentUser = ctx.getCurrentUser();
  if (!currentUser) {
    alert('Please sign in first');
    return;
  }

  var promoInput = document.getElementById('goPlusPromoCode');
  var promoMessage = document.getElementById('goPlusPromoMessage');
  var discountedPriceEl = document.getElementById('goPlusDiscountedPrice');
  var stripeBtn = document.getElementById('goPlusStripeBtn');
  var paypalBtn = document.getElementById('goPlusPayPalBtn');
  var applyBtn = document.getElementById('goPlusApplyPromo');

  var code = promoInput?.value.trim().toUpperCase();
  if (!code) {
    promoMessage.textContent = 'Please enter a promo code';
    promoMessage.className = 'promo-message error';
    return;
  }

  // Disable apply button while checking
  if (applyBtn) applyBtn.disabled = true;
  promoMessage.textContent = 'Checking...';
  promoMessage.className = 'promo-message';

  try {
    var response = await fetch('/api/plus/validate-promo/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: code,
        userId: currentUser.uid
      })
    });

    var result = await response.json();

    if (result.success && result.valid) {
      ctx.setAppliedPromoCode(code);
      promoMessage.textContent = result.message || 'Promo code applied!';
      promoMessage.className = 'promo-message success';
      discountedPriceEl?.classList.remove('hidden');
      promoInput.disabled = true;
      if (applyBtn) applyBtn.textContent = 'Applied';

      // Update button texts to show discounted price
      var stripeBtnText = stripeBtn?.querySelector('.btn-text');
      var paypalBtnText = paypalBtn?.querySelector('.btn-text');
      if (stripeBtnText) stripeBtnText.textContent = 'Pay with Card - £5';
      if (paypalBtnText) paypalBtnText.textContent = 'Pay with PayPal - £5';
    } else {
      ctx.setAppliedPromoCode(null);
      promoMessage.textContent = result.error || 'Invalid promo code';
      promoMessage.className = 'promo-message error';
      discountedPriceEl?.classList.add('hidden');
    }
  } catch (error) {
    console.error('Promo validation error:', error);
    promoMessage.textContent = 'Failed to validate code. Please try again.';
    promoMessage.className = 'promo-message error';
  } finally {
    if (applyBtn && applyBtn.textContent !== 'Applied') applyBtn.disabled = false;
  }
}

// Helper to set button loading state
function setPaymentButtonLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = loading;
  var btnText = btn.querySelector('.btn-text');
  var btnLoading = btn.querySelector('.btn-loading');
  if (btnText) btnText.classList.toggle('hidden', loading);
  if (btnLoading) btnLoading.classList.toggle('hidden', !loading);
}

// Reset all payment buttons to default state
function resetPaymentButtons() {
  var goPlusHeaderBtn = document.getElementById('goPlusHeaderBtn');
  var stripeBtn = document.getElementById('goPlusStripeBtn');
  var paypalBtn = document.getElementById('goPlusPayPalBtn');
  var priceText = ctx.getAppliedPromoCode() ? '£5' : '£10';

  if (goPlusHeaderBtn) {
    goPlusHeaderBtn.style.pointerEvents = '';
    var headerBtnText = goPlusHeaderBtn.querySelector('.pro-text');
    if (headerBtnText) headerBtnText.textContent = 'Go Plus';
  }

  if (stripeBtn) {
    stripeBtn.disabled = false;
    var stripeBtnText = stripeBtn.querySelector('.btn-text');
    var stripeBtnLoading = stripeBtn.querySelector('.btn-loading');
    if (stripeBtnText) { stripeBtnText.textContent = 'Pay with Card - ' + priceText; stripeBtnText.classList.remove('hidden'); }
    if (stripeBtnLoading) stripeBtnLoading.classList.add('hidden');
  }

  if (paypalBtn) {
    paypalBtn.disabled = false;
    var paypalBtnText = paypalBtn.querySelector('.btn-text');
    var paypalBtnLoading = paypalBtn.querySelector('.btn-loading');
    if (paypalBtnText) { paypalBtnText.textContent = 'Pay with PayPal - ' + priceText; paypalBtnText.classList.remove('hidden'); }
    if (paypalBtnLoading) paypalBtnLoading.classList.add('hidden');
  }
}

// Handle Stripe (card) payment
export async function handleStripeUpgrade() {
  var currentUser = ctx.getCurrentUser();
  if (!currentUser) {
    alert('Please sign in to upgrade');
    return;
  }

  var goPlusHeaderBtn = document.getElementById('goPlusHeaderBtn');
  var stripeBtn = document.getElementById('goPlusStripeBtn');
  var paypalBtn = document.getElementById('goPlusPayPalBtn');

  // Disable buttons and show processing state
  if (goPlusHeaderBtn) {
    goPlusHeaderBtn.style.pointerEvents = 'none';
    var headerBtnText = goPlusHeaderBtn.querySelector('.pro-text');
    if (headerBtnText) headerBtnText.textContent = 'Processing...';
  }
  setPaymentButtonLoading(stripeBtn, true);
  if (paypalBtn) paypalBtn.disabled = true;

  try {
    // Create Stripe checkout session for Pro subscription
    // Promo uses one-off payment, regular uses subscription
    var isPromo = !!ctx.getAppliedPromoCode();
    var response = await fetch('/api/create-checkout/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: isPromo ? 'payment' : 'subscription', // Promo is one-off payment
        priceId: isPromo ? 'plus_annual_promo' : 'plus_annual',
        userId: currentUser.uid,
        email: currentUser.email,
        promoCode: ctx.getAppliedPromoCode(),
        successUrl: window.location.origin + '/account/dashboard?upgraded=true',
        cancelUrl: window.location.origin + '/account/dashboard',
      })
    });

    var result = await response.json();

    if (result.success && result.checkoutUrl) {
      window.location.href = result.checkoutUrl;
    } else {
      throw new Error(result.error || 'Failed to create checkout session');
    }
  } catch (error) {
    console.error('Stripe upgrade error:', error);
    alert('Failed to start upgrade process. Please try again.');
    resetPaymentButtons();
  }
}

// Handle PayPal payment
export async function handlePayPalUpgrade() {
  var currentUser = ctx.getCurrentUser();
  if (!currentUser) {
    alert('Please sign in to upgrade');
    return;
  }

  var goPlusHeaderBtn = document.getElementById('goPlusHeaderBtn');
  var stripeBtn = document.getElementById('goPlusStripeBtn');
  var paypalBtn = document.getElementById('goPlusPayPalBtn');

  // Disable buttons and show processing state
  if (goPlusHeaderBtn) {
    goPlusHeaderBtn.style.pointerEvents = 'none';
    var headerBtnText = goPlusHeaderBtn.querySelector('.pro-text');
    if (headerBtnText) headerBtnText.textContent = 'Processing...';
  }
  setPaymentButtonLoading(paypalBtn, true);
  if (stripeBtn) stripeBtn.disabled = true;

  try {
    // Create PayPal order for Plus subscription
    var response = await fetch('/api/paypal/create-plus-order/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentUser.uid,
        email: currentUser.email,
        promoCode: ctx.getAppliedPromoCode()
      })
    });

    var result = await response.json();

    if (!result.success) {
      throw new Error(result.error || 'Failed to create PayPal order');
    }

    // Open PayPal approval URL
    var paypalWindow = window.open(result.approvalUrl, 'paypal_plus', 'width=500,height=700,left=200,top=100');

    // Poll for popup close and check for success
    ctx.setPaypalCheckInterval(setInterval(async function() {
      if (paypalWindow?.closed) {
        clearInterval(ctx.getPaypalCheckInterval());
        ctx.setPaypalCheckInterval(null);

        // Try to capture the order
        try {
          var captureResponse = await fetch('/api/paypal/capture-plus-order/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              paypalOrderId: result.paypalOrderId,
              orderData: result.orderData,
              expectedAmount: result.amount
            })
          });

          var captureResult = await captureResponse.json();

          if (captureResult.success) {
            // Redirect to success page
            window.location.href = '/account/dashboard/?upgraded=true';
          } else {
            // Payment was cancelled or failed
            resetPaymentButtons();
          }
        } catch (captureError) {
          console.error('PayPal capture error:', captureError);
          resetPaymentButtons();
        }
      }
    }, 500));

  } catch (error) {
    console.error('PayPal upgrade error:', error);
    alert(error instanceof Error ? error.message : 'Failed to start PayPal payment. Please try again.');
    resetPaymentButtons();
  }
}

// Go Plus Modal functionality
export function initGoPlusModal() {
  var goPlusHeaderBtn = document.getElementById('goPlusHeaderBtn');
  var modal = document.getElementById('goPlusModal');
  var closeBtn = document.getElementById('goPlusModalClose');
  var backdrop = modal?.querySelector('.goplus-modal-backdrop');
  var stripeBtn = document.getElementById('goPlusStripeBtn');
  var paypalBtn = document.getElementById('goPlusPayPalBtn');

  if (!goPlusHeaderBtn || !modal) {
    return;
  }

  // Open modal when header button is clicked
  goPlusHeaderBtn.addEventListener('click', function() {
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  });

  // Close modal function
  var closeModal = function() {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  };

  // Close on X button
  closeBtn?.addEventListener('click', closeModal);

  // Close on backdrop click
  backdrop?.addEventListener('click', closeModal);

  // Close on Escape key
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeModal();
    }
  });

  // Handle Stripe payment button
  stripeBtn?.addEventListener('click', handleStripeUpgrade);

  // Handle PayPal payment button
  paypalBtn?.addEventListener('click', handlePayPalUpgrade);

  // Handle promo code apply button
  var promoApplyBtn = document.getElementById('goPlusApplyPromo');
  promoApplyBtn?.addEventListener('click', handleApplyPromoCode);

  // Handle Enter key in promo input
  var promoInput = document.getElementById('goPlusPromoCode');
  promoInput?.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleApplyPromoCode();
    }
  });

  // Reset promo state when modal closes (override closeModal)
  var originalCloseModal = closeModal;
  closeModal = function() {
    originalCloseModal();
    // Reset promo code state
    ctx.setAppliedPromoCode(null);
    var promoInputEl = document.getElementById('goPlusPromoCode');
    var promoMessage = document.getElementById('goPlusPromoMessage');
    var discountedPriceEl = document.getElementById('goPlusDiscountedPrice');
    var promoBtnEl = document.getElementById('goPlusApplyPromo');
    var stripeBtnText = document.getElementById('goPlusStripeBtn')?.querySelector('.btn-text');
    var paypalBtnText = document.getElementById('goPlusPayPalBtn')?.querySelector('.btn-text');

    if (promoInputEl) { promoInputEl.value = ''; promoInputEl.disabled = false; }
    if (promoMessage) { promoMessage.textContent = ''; promoMessage.className = 'promo-message'; }
    if (discountedPriceEl) discountedPriceEl.classList.add('hidden');
    if (promoBtnEl) { promoBtnEl.textContent = 'Apply'; promoBtnEl.disabled = false; }
    if (stripeBtnText) stripeBtnText.textContent = 'Pay with Card - £10';
    if (paypalBtnText) paypalBtnText.textContent = 'Pay with PayPal - £10';
  };
}

// Check URL params for successful upgrade
export function checkUpgradeSuccess() {
  var params = new URLSearchParams(window.location.search);
  if (params.get('upgraded') === 'true') {
    // Show success message
    alert('Welcome to Plus! Your subscription is now active.');
    // Clean up URL
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}
