interface Database { query<T>(sql: string, values?: readonly unknown[]): Promise<T[]> }
export async function listUsers(db: Database): Promise<unknown[]> {
  const users = await db.query<{ id: string }>("SELECT id FROM users");
  return Promise.all(users.map(async (user) => ({ ...user, profile: (await db.query("SELECT * FROM profiles WHERE user_id = $1", [user.id]))[0] })));
}
