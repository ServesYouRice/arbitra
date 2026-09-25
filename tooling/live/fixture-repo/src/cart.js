// Shopping cart arithmetic for the storefront checkout.

/** Sum of price * quantity over the cart lines, in cents. */
export function subtotal(lines) {
  let total = 0;
  for (const line of lines) total += line.priceCents * line.quantity;
  return total;
}

/** Apply a percentage discount (0-100) to a total in cents. */
export function applyDiscount(totalCents, percent) {
  return Math.round(totalCents - (totalCents * percent) / 100);
}

/** Parse a quantity typed by the customer. */
export function parseQuantity(text) {
  return parseInt(text);
}
