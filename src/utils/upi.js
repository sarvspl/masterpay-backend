/**
 * UPI (India) helpers.
 *
 * Context that drives every design decision in here:
 *
 *  - A UPI QR is NOT app-specific. NPCI mandates interoperability, so one
 *    `upi://pay?...` payload is scannable by GPay, PhonePe, Paytm and every
 *    bank app alike. We expose "GPay" and "PhonePe" at checkout because a
 *    vendor may hold a different VPA in each app (vendor@okaxis vs vendor@ybl),
 *    not because the QR content differs.
 *
 *  - GPay and PhonePe send NO SMS. The payer's bank does. So the SMS matcher
 *    keys off the vendor's BANK, never off the app the payer chose — which is
 *    why gateways.bank_code exists and why gateways.account_number holds the
 *    bank account last-4 for UPI gateways rather than the VPA.
 *
 *  - The `tr` reference we put in the QR does NOT come back in the bank SMS.
 *    The SMS carries NPCI's own 12-digit RRN/UTR. Never match on `tr`.
 */

const UPI_PROVIDERS = ['gpay', 'phonepe'];

/**
 * UPI address: <identifier>@<handle>. NPCI allows alphanumerics plus . - _ in
 * the identifier; the handle is a PSP bank suffix (okaxis, ybl, oksbi, paytm...).
 */
const VPA_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,254})@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;

/**
 * Registered DLT sender headers per bank.
 *
 * Under TRAI's DLT regime an Indian sender ID is a SIX-character alphanumeric
 * header, delivered wrapped in an operator prefix and a category suffix that
 * vary by telco and circle — 'SBIUPI', 'JD-SBIUPI-S', 'AX-SBIUPI'. The device
 * matcher parses the header out of those shapes and compares it to this list
 * exactly, so every entry here MUST be exactly 6 characters; a 4- or 7-char
 * entry would silently never match. assertValidHeaders() below enforces that at
 * boot rather than letting it fail quietly in production.
 *
 * SINGLE SOURCE OF TRUTH. These are resolved server-side and shipped to the
 * device in the /api/device/poll payload as `sender_hints`, so adding a bank
 * here needs NO app release. Do not duplicate this map into matcher.js.
 */
const BANK_SENDERS = {
  sbi:        { name: 'State Bank of India',   hints: ['SBIUPI', 'SBIBNK', 'CBSSBI', 'SBIINB', 'ATMSBI'] },
  hdfc:       { name: 'HDFC Bank',             hints: ['HDFCBK', 'HDFCBN'] },
  icici:      { name: 'ICICI Bank',            hints: ['ICICIB', 'ICICIT'] },
  axis:       { name: 'Axis Bank',             hints: ['AXISBK', 'AXISBN'] },
  kotak:      { name: 'Kotak Mahindra Bank',   hints: ['KOTAKB', 'KMBLTX'] },
  pnb:        { name: 'Punjab National Bank',  hints: ['PNBSMS', 'PNBBNK'] },
  bob:        { name: 'Bank of Baroda',        hints: ['BOBSMS', 'BOBTXN', 'BOBIBK'] },
  canara:     { name: 'Canara Bank',           hints: ['CANBNK', 'CANARA'] },
  union:      { name: 'Union Bank of India',   hints: ['UNIONB'] },
  cbi:        { name: 'Central Bank of India', hints: ['CENTBK', 'CBIIND'] },
  idfc:       { name: 'IDFC FIRST Bank',       hints: ['IDFCFB', 'IDFCBK'] },
  yes:        { name: 'YES Bank',              hints: ['YESBNK', 'YESBLR'] },
  indusind:   { name: 'IndusInd Bank',         hints: ['INDUSB', 'INDUSD'] },
  federal:    { name: 'Federal Bank',          hints: ['FEDBNK', 'FEDERL'] },
  iob:        { name: 'Indian Overseas Bank',  hints: ['IOBCHN', 'IOBBNK'] },
  uco:        { name: 'UCO Bank',              hints: ['UCOBNK'] },
  indian:     { name: 'Indian Bank',           hints: ['INDBNK', 'ALLBNK'] },
  boi:        { name: 'Bank of India',         hints: ['BOIIND', 'BOISMS'] },
  rbl:        { name: 'RBL Bank',              hints: ['RBLBNK'] },
  au:         { name: 'AU Small Finance Bank', hints: ['AUBANK', 'AUSFBL'] },
  // Seen live as 'BG-BDNSMS-S'.
  bandhan:    { name: 'Bandhan Bank',          hints: ['BDNSMS'] },
};

/**
 * Fail fast at boot on a malformed header. A wrong-length entry can't ever match
 * a parsed DLT header, so every payment through that bank would fall to manual
 * review with no obvious cause — exactly the kind of fault that hides for weeks.
 */
function assertValidHeaders() {
  const bad = [];
  for (const [code, entry] of Object.entries(BANK_SENDERS)) {
    for (const h of entry.hints) {
      if (!/^[A-Z0-9]{6}$/.test(h)) bad.push(`${code}: "${h}"`);
    }
  }
  if (bad.length) {
    throw new Error(
      `Invalid DLT sender header(s) in BANK_SENDERS — must be exactly 6 uppercase alphanumerics: ${bad.join(', ')}`
    );
  }
}
assertValidHeaders();

/**
 * The only currency each payment rail can physically receive.
 *
 * Covers every rail, not just UPI — it lives here because the India work is what
 * made it matter. Mirrors PROVIDER_CURRENCY in mobile/src/lib/matcher.js and
 * Matcher.kt; the device applies the same rule when matching an SMS, so the two
 * MUST agree. If they drift, checkout offers a gateway that verification then
 * refuses.
 */
const PROVIDER_CURRENCY = {
  gpay:    'INR',
  phonepe: 'INR',
  bkash:   'BDT',
  nagad:   'BDT',
  rocket:  'BDT',
  upay:    'BDT',
};

/** Currencies we have SMS keywords for, and can therefore reason about. */
const MODELLED_CURRENCIES = new Set(['INR', 'BDT']);

/**
 * Providers that cannot receive `currency`, for filtering a checkout.
 *
 * Returns [] when we don't model the currency — a merchant billing in USD while
 * collecting through bKash is not a contradiction we can judge, and hiding every
 * gateway would leave them with an empty checkout. Same rule the device matcher
 * uses before flagging a currency conflict.
 */
function providersNotAccepting(currency) {
  const c = String(currency || '').toUpperCase();
  if (!MODELLED_CURRENCIES.has(c)) return [];
  return Object.entries(PROVIDER_CURRENCY)
    .filter(([, railCurrency]) => railCurrency !== c)
    .map(([provider]) => provider);
}

/** The currency a rail settles in, or null if we don't model that provider. */
function railCurrency(provider) {
  return PROVIDER_CURRENCY[String(provider || '').toLowerCase()] || null;
}

/**
 * Sessions where the payer is paying the PLATFORM rather than a vendor:
 * merchant wallet top-up, vendor wallet top-up, vendor activation fee, and
 * device-key unlock.
 *
 * These are the only checkouts that offer rails settling in another currency.
 * The payer is a business counterparty choosing how to settle its own bill, and
 * the checkout states the charge currency plainly — whereas a consumer paying a
 * vendor must never be shown a rail that takes a different currency than the
 * price they agreed to.
 *
 * Keep in sync with the `type:` values written into payment_sessions.metadata:
 *   wallet_topup      wallet.controller.js
 *   vendor_topup      vendor.controller.js
 *   vendor_activation vendor.controller.js, adminVendors.controller.js, services/activation.js
 *   key_unlock        accounts.controller.js, merchant.controller.js
 */
const PLATFORM_COLLECTED_TYPES = new Set([
  'wallet_topup',
  'vendor_topup',
  'vendor_activation',
  'key_unlock',
]);

function isPlatformCollected(session) {
  const t = session && session.metadata && session.metadata.type;
  return PLATFORM_COLLECTED_TYPES.has(String(t || ''));
}

function isUpiProvider(provider) {
  return UPI_PROVIDERS.includes(String(provider || '').toLowerCase());
}

function isValidVpa(vpa) {
  return typeof vpa === 'string' && VPA_RE.test(vpa.trim());
}

function normalizeVpa(vpa) {
  return String(vpa || '').trim().toLowerCase();
}

function listBanks() {
  return Object.entries(BANK_SENDERS)
    .map(([code, b]) => ({ code, name: b.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Sender-ID fragments for a bank_code. Returns [] for an unknown/absent code —
 * the device matcher treats an empty list as "fall back to the generic DLT
 * sender check", never as "allow anything".
 */
function senderHintsForBank(bankCode) {
  const entry = BANK_SENDERS[String(bankCode || '').toLowerCase()];
  return entry ? entry.hints.slice() : [];
}

/**
 * The 6-char DLT header of an Indian sender ID ('SBIUPI', 'JD-SBIUPI-S',
 * 'AX-SBIUPI'), or null for anything else — notably a personal mobile number.
 * Same shapes as parseIndianSenderHeader() in the device matcher.
 */
function dltHeader(address) {
  const m = String(address || '').trim().toUpperCase()
    .match(/^(?:[A-Z]{2}-([A-Z0-9]{6})(?:-[A-Z])?|([A-Z0-9]{6}))$/);
  return m ? (m[1] || m[2]) : null;
}

/**
 * True when an SMS sender is one of this bank's registered headers. An unknown
 * bank has no list and never passes — server-side settlement fails closed.
 */
function isBankSender(address, bankCode) {
  const header = dltHeader(address);
  return !!header && senderHintsForBank(bankCode).includes(header);
}

/**
 * Extract a VPA from a scanned/pasted UPI QR payload.
 * Accepts a full `upi://pay?pa=x@y&...` URI or a bare VPA. Returns null if
 * neither. Used to normalise whatever a vendor pastes or uploads into one
 * stored VPA.
 */
function extractVpa(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // Bare VPA
  if (isValidVpa(raw)) return normalizeVpa(raw);

  // upi://pay?pa=... (also handles the bank-app variants: upi://pay, upi://collect)
  const m = raw.match(/[?&]pa=([^&\s]+)/i);
  if (m) {
    const decoded = decodeURIComponent(m[1]);
    if (isValidVpa(decoded)) return normalizeVpa(decoded);
  }
  return null;
}

/**
 * Build the interoperable UPI payment URI. This exact string is what gets
 * QR-encoded and what the app deep-links use.
 *
 * amount is formatted to 2dp because UPI apps reject bare integers on some
 * PSPs, and because the matcher compares against the same 2dp string.
 */
function buildUpiUri({ vpa, payeeName, amount, note }) {
  if (!isValidVpa(vpa)) throw new Error('invalid vpa');

  // Deliberately NOT URLSearchParams. It emits application/x-www-form-urlencoded,
  // which encodes space as '+' — UPI apps render that literally, so a payee name
  // arrives as "Rounak+Store". We need percent-encoding (%20) instead.
  const enc = (v) => encodeURIComponent(String(v));

  const parts = [];
  // '@' is left literal in `pa`: that is how every real-world UPI QR is written,
  // and some PSP apps fail to decode %40 in the payee address.
  parts.push(`pa=${enc(normalizeVpa(vpa)).replace(/%40/g, '@')}`);
  if (payeeName) parts.push(`pn=${enc(String(payeeName).slice(0, 50))}`);
  if (amount != null) parts.push(`am=${Number(amount).toFixed(2)}`);
  parts.push('cu=INR');
  if (note) {
    // UPI notes reject most punctuation; keep it conservative and short.
    const clean = String(note).replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 40);
    if (clean) parts.push(`tn=${enc(clean)}`);
  }
  return `upi://pay?${parts.join('&')}`;
}

/**
 * App-specific deep links, for the payer's own phone (a QR is useless on the
 * device you're holding). These custom schemes are NOT documented by NPCI and
 * do break across app versions — always render the generic `upi://` URI as a
 * fallback alongside them.
 */
const APP_SCHEMES = {
  gpay:    'tez://upi/pay',
  phonepe: 'phonepe://pay',
  paytm:   'paytmmp://pay',
};

function buildAppUri(provider, upiUri) {
  const scheme = APP_SCHEMES[String(provider || '').toLowerCase()];
  if (!scheme) return null;
  const qs = upiUri.split('?')[1] || '';
  return `${scheme}?${qs}`;
}

module.exports = {
  UPI_PROVIDERS,
  VPA_RE,
  PROVIDER_CURRENCY,
  providersNotAccepting,
  railCurrency,
  isPlatformCollected,
  PLATFORM_COLLECTED_TYPES,
  isUpiProvider,
  isValidVpa,
  normalizeVpa,
  listBanks,
  senderHintsForBank,
  dltHeader,
  isBankSender,
  extractVpa,
  buildUpiUri,
  buildAppUri,
};
