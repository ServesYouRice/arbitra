interface Store { stock(sku: string): Promise<number>; setStock(sku: string, value: number): Promise<void> }
export async function reserve(store: Store, sku: string, quantity: number): Promise<boolean> {
  const available = await store.stock(sku);
  if (available < quantity) return false;
  await store.setStock(sku, available - quantity);
  return true;
}
