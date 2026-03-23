// Dashboard — credits/gift card module
// Handles credit balance display, transactions, and gift card redemption

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

var ctx = null;
var userCreditBalance = 0;
var creditTransactions = [];

export function init(context) {
  ctx = context;
}

export async function loadCreditBalance(userId) {
  try {
    // Get auth token for secure API call
    var currentUser = ctx.getCurrentUser();
    var idToken = currentUser ? await currentUser.getIdToken() : null;
    if (!idToken) {
      console.error('[Dashboard] No auth token for credit balance');
      return;
    }

    var balanceController = new AbortController();
    var balanceTimeout = setTimeout(function() { balanceController.abort(); }, 15000);
    var response = await fetch('/api/giftcards/balance/?userId=' + userId, {
      headers: {
        'Authorization': 'Bearer ' + idToken
      },
      signal: balanceController.signal
    });
    clearTimeout(balanceTimeout);
    var result = await response.json();

    if (result.success) {
      userCreditBalance = result.balance || 0;
      creditTransactions = result.transactions || [];

      // Update balance display
      var balanceEl = document.getElementById('creditBalanceDisplay');
      if (balanceEl) {
        balanceEl.textContent = '£' + userCreditBalance.toFixed(2);
      }

      // Update badge
      var badge = document.getElementById('creditBadge');
      if (badge) {
        if (userCreditBalance > 0) {
          badge.textContent = '£' + userCreditBalance.toFixed(0);
          badge.style.display = 'inline';
        } else {
          badge.style.display = 'none';
        }
      }

      // Render transactions
      renderTransactions(creditTransactions);
    }
  } catch (error) {
    console.error('Error loading credit balance:', error);
  }
}

function renderTransactions(transactions) {
  var container = document.getElementById('transactionsList');
  if (!container) return;

  if (!transactions || transactions.length === 0) {
    container.innerHTML =
      '<div class="empty-state">' +
        '<p style="color: #d1d5db;">No transactions yet</p>' +
      '</div>';
    return;
  }

  container.innerHTML = transactions.map(function(txn) {
    var isCredit = txn.amount > 0;
    var date = new Date(txn.createdAt).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });

    return '<div class="transaction-item ' + (isCredit ? 'credit' : 'debit') + '">' +
      '<div class="transaction-info">' +
        '<span class="transaction-desc">' + escapeHtml(txn.description) + '</span>' +
        '<span class="transaction-date">' + escapeHtml(date) + '</span>' +
      '</div>' +
      '<span class="transaction-amount ' + (isCredit ? 'positive' : 'negative') + '">' +
        (isCredit ? '+' : '') + '£' + Math.abs(txn.amount).toFixed(2) +
      '</span>' +
    '</div>';
  }).join('');
}

export function initCreditTab() {
  var form = document.getElementById('dashboardRedeemForm');
  var codeInput = document.getElementById('dashboardGiftCode');

  // Format code as user types
  if (codeInput) {
    codeInput.addEventListener('input', function(e) {
      var value = e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '');

      if (value.length > 4) {
        var prefix = value.substring(0, 4);
        var rest = value.substring(4);
        var chunks = rest.match(/.{1,4}/g) || [];
        value = prefix + '-' + chunks.join('-');
      }

      e.target.value = value;
    });
  }

  if (form) {
    form.addEventListener('submit', async function(e) {
      e.preventDefault();

      var currentUser = ctx.getCurrentUser();
      if (!currentUser) return;

      var code = codeInput.value.trim();
      var btn = document.getElementById('dashboardRedeemBtn');
      var btnText = btn.querySelector('.btn-text');
      var btnLoading = btn.querySelector('.btn-loading');
      var errorEl = document.getElementById('dashboardRedeemError');
      var successEl = document.getElementById('dashboardRedeemSuccess');

      errorEl.style.display = 'none';
      successEl.style.display = 'none';

      if (!code) {
        errorEl.textContent = 'Please enter a gift card code';
        errorEl.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btnText.classList.add('hidden');
      btnLoading.classList.remove('hidden');

      try {
        var idToken = await currentUser.getIdToken();
        var redeemController = new AbortController();
        var redeemTimeout = setTimeout(function() { redeemController.abort(); }, 15000);
        var response = await fetch('/api/giftcards/redeem/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
          body: JSON.stringify({ code: code }),
          signal: redeemController.signal
        });
        clearTimeout(redeemTimeout);

        var result = await response.json();

        if (result.success) {
          successEl.textContent = result.message;
          successEl.style.display = 'block';
          codeInput.value = '';

          // Reload credit balance
          await loadCreditBalance(currentUser.uid);
        } else {
          errorEl.textContent = result.error || 'Failed to redeem gift card';
          errorEl.style.display = 'block';
        }
      } catch (error) {
        console.error('Redeem error:', error);
        errorEl.textContent = 'Something went wrong. Please try again.';
        errorEl.style.display = 'block';
      } finally {
        btn.disabled = false;
        btnText.classList.remove('hidden');
        btnLoading.classList.add('hidden');
      }
    });
  }
}
