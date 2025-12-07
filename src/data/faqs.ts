// src/data/faqs.ts
// Common FAQs for Fresh Wax - use these on relevant pages

export interface FAQ {
  question: string;
  answer: string;
}

// Homepage / General FAQs
export const generalFAQs: FAQ[] = [
  {
    question: "What is Fresh Wax?",
    answer: "Fresh Wax is an independent UK-based online music store specialising in jungle & drum and bass music. We offer digital downloads, limited edition vinyl pressings, exclusive DJ mixes, Live streams and official merchandise."
  },
  {
    question: "What genres do you stock?",
    answer: "We focus on jungle, drum & bass (d&b/dnb) and related electronic music sub-genres. Our catalogue features new releases from UK and international artists."
  },
  {
    question: "Do you ship internationally?",
    answer: "Digital downloads are available instantly to customers anywhere in the world. Shipping costs and delivery times vary by location - check our <a href='/shipping'>shipping page</a> for details."
  },
  {
    question: "How do digital downloads work?",
    answer: "After purchase, you'll receive instant access to download your tracks in high-quality formats including WAV and MP3. Downloads are available from your account dashboard and can be re-downloaded at any time."
  }
];

// Shipping & Delivery FAQs
export const shippingFAQs: FAQ[] = [
  {
    question: "How much does shipping cost?",
    answer: "UK postage by DPD or Royal Mail, you will be given a choice of postal methods. International shipping rates vary by destination. Exact costs are calculated at checkout."
  },
  {
    question: "How long does delivery take?",
    answer: "UK orders typically arrive either next day or within 2-5 working days depending on the postal method selected and cut-off time. European orders take 5-10 working days, and worldwide orders 7-21 working days depending on destination and customs processing."
  },
  {
    question: "Do you offer tracked shipping?",
    answer: "Yes, all orders include tracking. You can check your account dashboard for updates on tracking information once your order is despatched."
  },
  {
    question: "What if my vinyl arrives damaged?",
    answer: "We carefully pack all vinyl in protective mailers to prevent damage. If your record arrives damaged, contact us within 48 hours with photos and we'll arrange a replacement or refund. See our <a href='/returns'>returns policy</a> for details."
  }
];

// Vinyl-specific FAQs
export const vinylFAQs: FAQ[] = [
  {
    question: "What condition are your vinyl records in?",
    answer: "All vinyl sold on Fresh Wax is brand new and direct form either the label or main stockist."
  },
  {
    question: "Are your releases limited edition?",
    answer: "Many of our vinyl releases are limited pressings, often limited to 30-100 copies. Once sold out, they may not be repressed. We clearly state pressing quantities on each product page."
  },
  {
    question: "What vinyl weights do you stock?",
    answer: "Most of the releases are pressed on 140g-180g vinyl for superior sound quality and durability. Standard 12\" releases typically run at 45 RPM for optimal bass response."
  },
  {
    question: "Can I pre-order upcoming releases?",
    answer: "Yes, we regularly offer pre-orders for upcoming releases. Pre-order items are clearly marked with expected release dates. Your card is charged at the time of order, and items ship as soon as they're available."
  }
];

// DJ Mixes FAQs
export const djMixFAQs: FAQ[] = [
  {
    question: "Are DJ mixes free to download?",
    answer: "Yes! All DJ mixes on Fresh Wax are free to stream and download. Simply create an account, and you'll have unlimited access to our growing library of exclusive mixes from top jungle and d&b DJs."
  },
  {
    question: "Can I upload my own DJ mix?",
    answer: "We accept mix submissions from DJs! You'll need to register as a DJ on our platform and meet our eligibility requirements. Check the <a href='/account/go-live'>DJ requirements</a> page for more information."
  },
  {
    question: "What audio quality are the mixes?",
    answer: "All DJ mixes are available in high-quality 320kbps MP3 format, perfect for both listening and DJ practice. Some mixes are also available in lossless WAV format."
  },
  {
    question: "Can I use Fresh Wax mixes in my streams?",
    answer: "Our mixes are for personal listening only. For streaming or public performance rights, please contact the individual DJ or our support team."
  }
];

// Live Streaming FAQs
export const liveStreamFAQs: FAQ[] = [
  {
    question: "When do you have live streams?",
    answer: "We host live DJ streams regularly, featuring both resident and guest DJs. Check our <a href='/live'>live page</a> for the current schedule or follow us on social media for announcements."
  },
  {
    question: "How do I watch live streams?",
    answer: "Simply visit our <a href='/live'>live page</a> when a stream is active. No account required to watch! Create an account to participate in the live chat and receive notifications."
  },
  {
    question: "Can I become a resident DJ?",
    answer: "We're always looking for talented DJs to book a slot. Upload a mix to our platform and apply through the <a href='/account/go-live'>Go Live</a> section of your account."
  },
  {
    question: "Are past streams available to rewatch?",
    answer: "Fresh Wax does not store past streams, but you can record any show from the Live stream page. This will download as an MP3 to your downloads folder when you stop the recording."
  }
];

// Returns & Refunds FAQs
export const returnsFAQs: FAQ[] = [
  {
    question: "What is your return policy?",
    answer: "We offer a 14-day return policy for physical items in their original, sealed condition. Digital downloads are non-refundable once downloaded. See our full <a href='/returns'>returns policy</a> for details."
  },
  {
    question: "How do I request a return or refund?",
    answer: "Contact us at info@freshwax.co.uk within 14 days of receiving your order. Include your order number and reason for return. We'll provide a returns address and process your refund once we receive the item."
  },
  {
    question: "Can I exchange an item?",
    answer: "If you'd like to exchange an item for a different product, please return the original item for a refund and place a new order for the item you want."
  },
  {
    question: "How long do refunds take?",
    answer: "Refunds are processed within 5-7 working days of receiving your return. The refund will be credited to your original payment method. Digital purchase refunds are processed within 48 hours when eligible."
  }
];

// Account FAQs
export const accountFAQs: FAQ[] = [
  {
    question: "How do I create an account?",
    answer: "Click 'Register' in the top navigation and fill in your details. You can also sign up during checkout. An account lets you track orders, download purchases, and access exclusive features."
  },
  {
    question: "I forgot my password - how do I reset it?",
    answer: "Click 'Login' then 'Forgot Password'. Enter your email address and we'll send you a reset link. Check your spam folder if you don't receive it within a few minutes."
  },
  {
    question: "Can I become an artist or label on Fresh Wax?",
    answer: "We welcome submissions from jungle, d&b, and breakbeat artists and labels. Contact us at info@freshwax.co.uk with links to your music and we'll be in touch."
  },
  {
    question: "How do I update my email or address?",
    answer: "Log into your account and visit the <a href='/account/dashboard'>Account Dashboard</a>. You can update your email, shipping address, and other details there."
  }
];

// Payment FAQs
export const paymentFAQs: FAQ[] = [
  {
    question: "What payment methods do you accept?",
    answer: "We accept all major credit and debit cards (Visa, Mastercard, American Express), PayPal, Apple Pay, and Google Pay. All payments are processed securely through Stripe."
  },
  {
    question: "Is it safe to use my card on your site?",
    answer: "Absolutely. We use Stripe for payment processing, one of the world's most trusted payment platforms. Your card details are encrypted and never stored on our servers."
  },
  {
    question: "Do you offer payment plans?",
    answer: "We don't currently offer payment plans, but we do sell gift cards that can be used to spread the cost of larger orders over time."
  },
  {
    question: "Can I use a gift card?",
    answer: "Yes! Fresh Wax gift cards can be used for any purchase on our site. Enter your gift card code at checkout to apply the balance. See our <a href='/giftcards'>gift cards page</a> for more info."
  }
];

// Combine all FAQs for a comprehensive FAQ page
export const allFAQs: FAQ[] = [
  ...generalFAQs,
  ...shippingFAQs,
  ...vinylFAQs,
  ...djMixFAQs,
  ...paymentFAQs,
  ...returnsFAQs
];

// Export grouped FAQs by category
export const faqsByCategory = {
  general: { title: 'General Questions', faqs: generalFAQs },
  shipping: { title: 'Shipping & Delivery', faqs: shippingFAQs },
  vinyl: { title: 'Vinyl Records', faqs: vinylFAQs },
  djMixes: { title: 'DJ Mixes', faqs: djMixFAQs },
  liveStreams: { title: 'Live Streams', faqs: liveStreamFAQs },
  returns: { title: 'Returns & Refunds', faqs: returnsFAQs },
  account: { title: 'Account', faqs: accountFAQs },
  payment: { title: 'Payment', faqs: paymentFAQs }
};
