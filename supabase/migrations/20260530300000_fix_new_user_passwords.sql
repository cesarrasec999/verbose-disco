-- Hashear contraseñas que quedaron en texto plano (usuarios creados después de la migración inicial)
UPDATE cyclic_users
SET password = extensions.crypt(password, extensions.gen_salt('bf', 10))
WHERE password IS NOT NULL
  AND (length(password) < 60 OR password NOT LIKE '$2%');

-- Función para hashear contraseñas desde el cliente (usada por UsersModule al crear/editar usuarios)
CREATE OR REPLACE FUNCTION hash_password(p_password TEXT)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT extensions.crypt(p_password, extensions.gen_salt('bf', 10));
$$;

GRANT EXECUTE ON FUNCTION hash_password(TEXT) TO anon, authenticated;
