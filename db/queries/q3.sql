SELECT id, email, role, created_at
FROM users
WHERE lower(email) = lower('User31337@Example.com')
