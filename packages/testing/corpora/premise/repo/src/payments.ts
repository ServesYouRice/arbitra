interface Gateway { capture(paymentId: string, amount: number): Promise<void> }
export async function capturePayment(gateway: Gateway, paymentId: string, amount: number): Promise<void> {
  try { await gateway.capture(paymentId, amount); }
  catch { await gateway.capture(paymentId, amount); }
}
