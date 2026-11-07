# assera-bills

Robot that retrieves utility bills for Assera Property Group.

- Passwords are NEVER stored here. They are set as private environment variables in Coolify
  (for example `HYDROONE_USER_1`, `HYDROONE_PASS_1`).
- `src/hydroone.js` logs in to Hydro One, opens each account, captures the current bill PDF,
  and prints a short, masked report to the log. It sends nothing and changes nothing.
