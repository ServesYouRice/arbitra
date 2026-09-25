import assert from "node:assert/strict";
import test from "node:test";

import { subtotal } from "../src/cart.js";

test("sums cart lines", () => {
  assert.equal(subtotal([{ priceCents: 250, quantity: 2 }, { priceCents: 100, quantity: 1 }]), 600);
});
