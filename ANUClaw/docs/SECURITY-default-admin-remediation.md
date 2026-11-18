# Remediating former default administrator accounts

Earlier ANUClaw versions created two administrator accounts automatically on a
fresh PostgreSQL database, both with the same published password:

- `admin@amgi.io`
- `admin@anuclaw.local`

Current versions create no default accounts. The first administrator comes only
from `ANUCLAW_BOOTSTRAP_ADMIN_EMAIL` / `ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD` (see
`.env.example`). **Upgrading does not remove or change existing accounts.** Any
database initialised by an earlier version may still contain these accounts, and
anyone who can reach the dashboard can sign in to them if the password was never
changed.

At startup the server logs a warning (a count only, no values) when accounts with
these addresses exist. It does not alter them.

## Check

Run against the affected database, with an operator account that has
appropriate access:

```sql
SELECT id, email, role, created_at, last_login_at
FROM dash_users
WHERE LOWER(email) IN ('admin@amgi.io', 'admin@anuclaw.local');
```

Treat any row as compromised unless you know its password was changed to a strong,
unique value. Review `last_login_at` and `audit_events` for unexpected use.

## Remediate

Do this from a separate administrator account you control. On a database whose only
admins are the legacy ones, first create your own admin through the dashboard
Users page while signed in to a legacy account, then sign in as the new one.

1. **Delete** each legacy account (preferred): dashboard **Users** page, or
   `DELETE /api/users/:id` as an admin. Deleting also revokes that user's sessions.
2. **Or reset** its password to a strong unique value (`PATCH /api/users/:id/password`)
   and revoke existing sessions:

   ```sql
   UPDATE dash_sessions SET revoked = 1 WHERE user_id = '<legacy user id>';
   ```

3. Reset E-LAB 2FA enrolment for any retained legacy account if it might have
   been enrolled by someone else.
4. Restart and confirm the startup warning no longer appears.

Do not paste passwords, hashes, or session tokens into tickets, chat, or logs.
