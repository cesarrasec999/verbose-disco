-- pgcrypto ya está instalado en Supabase en el schema "extensions"
-- No es necesario crear la extensión, solo referenciar las funciones correctamente

-- Hashear todas las contraseñas existentes en texto plano
-- Los hashes bcrypt tienen 60 caracteres y empiezan con '$2'
-- Las contraseñas en texto plano son más cortas o no tienen ese prefijo
UPDATE cyclic_users
SET password = extensions.crypt(password, extensions.gen_salt('bf', 10))
WHERE password IS NOT NULL
  AND (length(password) < 60 OR password NOT LIKE '$2%');

-- Función segura para verificar login (reemplaza el .eq("password") directo desde el cliente)
-- SECURITY DEFINER: corre con permisos del creador, bypassea RLS para la comparación
CREATE OR REPLACE FUNCTION verify_cyclic_user(p_username TEXT, p_password TEXT)
RETURNS TABLE (
  id uuid,
  username text,
  full_name text,
  role text,
  store_id uuid,
  can_access_all_stores boolean,
  can_access_audit boolean,
  module_access jsonb,
  is_active boolean,
  whatsapp text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    id,
    username,
    full_name,
    role,
    store_id,
    can_access_all_stores,
    can_access_audit,
    module_access,
    is_active,
    whatsapp
  FROM cyclic_users
  WHERE username = p_username
    AND password = crypt(p_password, password)
    AND is_active = true
  LIMIT 1;
$$;

-- Función segura para cambiar contraseña (verifica la clave anterior antes de cambiar)
CREATE OR REPLACE FUNCTION change_cyclic_user_password(
  p_username TEXT,
  p_old_password TEXT,
  p_new_password TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT id INTO v_user_id
  FROM cyclic_users
  WHERE username = p_username
    AND password = crypt(p_old_password, password)
    AND is_active = true;

  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  UPDATE cyclic_users
  SET password = crypt(p_new_password, gen_salt('bf', 10))
  WHERE id = v_user_id;

  RETURN TRUE;
END;
$$;

-- Dar acceso a las funciones desde el cliente con la anon key
GRANT EXECUTE ON FUNCTION verify_cyclic_user(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION change_cyclic_user_password(TEXT, TEXT, TEXT) TO anon, authenticated;
