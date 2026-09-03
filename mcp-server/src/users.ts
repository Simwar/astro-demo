/**
 * Demo user directory. In a real server this is your existing user store /
 * identity provider; here it's a hardcoded list so the login screen has
 * something to authenticate against.
 */
export interface DemoUser {
  id: string;
  username: string;
  password: string;
}

export const DEMO_USERS: DemoUser[] = [
  { id: "user-alice", username: "alice", password: "password" },
  { id: "user-bob", username: "bob", password: "password" },
];

export function authenticate(username: string, password: string): DemoUser | undefined {
  return DEMO_USERS.find((u) => u.username === username && u.password === password);
}

export function getUserById(id: string): DemoUser | undefined {
  return DEMO_USERS.find((u) => u.id === id);
}
