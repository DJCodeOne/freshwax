// Newsletter form handler (Footer component)
function initNewsletterForm() {
  var form = document.getElementById('newsletter-form');
  var emailInput = document.getElementById('newsletter-email');
  var btn = document.getElementById('newsletter-btn');
  var message = document.getElementById('newsletter-message');
  var consentInput = document.getElementById('newsletter-consent');

  if (!form) return;
  if (form.hasAttribute('data-newsletter-init')) return; // Prevent double-init
  form.setAttribute('data-newsletter-init', 'true');

  form.addEventListener('submit', async function(e) {
    e.preventDefault();

    // Prevent double-submit
    if (btn.disabled) return;

    var email = emailInput ? emailInput.value.trim() : '';
    if (!email) return;

    if (!consentInput || !consentInput.checked) {
      if (message) {
        message.textContent = 'Please agree to receive marketing emails.';
        message.className = 'mt-2 text-xs text-red-500';
        message.classList.remove('hidden');
      }
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Subscribing...';
    message.classList.add('hidden');

    try {
      var response = await fetch('/api/newsletter/subscribe/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, source: 'footer', consent: true })
      });

      if (!response.ok) throw new Error('Something went wrong');
      var data = await response.json();

      if (data.success) {
        message.textContent = data.message || 'Successfully subscribed!';
        message.className = 'mt-3 text-sm text-green-500';
        message.classList.remove('hidden');
        form.reset();
      } else {
        message.textContent = data.error || 'Failed to subscribe. Please try again.';
        message.className = 'mt-3 text-sm text-red-500';
        message.classList.remove('hidden');
      }
    } catch (err) {
      message.textContent = 'An error occurred. Please try again.';
      message.className = 'mt-3 text-sm text-red-500';
      message.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Subscribe';
    }
  });
}

// astro:page-load fires on both initial load and View Transitions
document.addEventListener('astro:page-load', initNewsletterForm);
