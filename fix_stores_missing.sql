-- Insertar tiendas faltantes en stores
-- erp_sede = NULL para no colisionar con el UNIQUE constraint
-- ON CONFLICT (code) DO NOTHING para no sobreescribir existentes

INSERT INTO stores (id, code, name, is_active, created_at, updated_at, erp_sede, erp_store_no)
VALUES
  -- StoreNo = 0 (CD-GPC, el almacén central — actualmente guardado como code='CD-GPC' pero DocStoreNo=0)
  (gen_random_uuid(), '0',    'CD-GPC',                          true, NOW(), NOW(), NULL, '0'),
  -- Alias StoreCode (1000-1027) usados por syncs de picking y recepción
  (gen_random_uuid(), '1000', 'CD-GPC',                          true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1001', 'GPC001 LIM - PERLA',              true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1002', 'GPC004 LIM - TIENDA VIRTUAL',     true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1003', 'GPC005 LIM - CORPORATIVO',        true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1004', 'GPC002 LIM - SUMINISTRO',         true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1005', 'GPC003 LIM - GRUPO',              true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1006', 'GPC006 LIM - CALLAO',             true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1007', 'GPC007 LIB - TRUJILLO',           true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1008', 'GPC008 LAM - CHI. DIAMANTE',      true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1009', 'GPC009 LAM - CHI. LEGUIA',        true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1010', 'GPC010 LIM - HUAROCHIRI',         true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1011', 'GPC011 LIM - NARANJAL',           true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1012', 'GPC012 PIU - PIURA',              true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1013', 'GPC013 ARE - EVITAMIENTO',        true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1014', 'GPC014 LIM - SURQUILLO',          true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1015', 'GPC015 JUN - HUANCAYO',           true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1016', 'GPC016 LIM - LURIN',              true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1017', 'GPC017 LIM - ARRIOLA',            true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1018', 'GPC018 LIM - VILLA EL SALVADOR',  true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1020', 'GPC020 LIM - CHORILLOS',          true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1021', 'GPC021 LIM - PUENTE PIEDRA',      true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1022', 'GPC022 LIM - HUACHIPA',           true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1023', 'GPC023 ARE - MIRAFLORES',         true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1024', 'GPC024 CAJ - CAJAMARCA',          true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1025', 'GPC025 APU - ABANCAY',            true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1026', 'GPC026 ICA - ICA',                true, NOW(), NOW(), NULL, NULL),
  (gen_random_uuid(), '1027', 'GPC027 CUS - CUSCO',              true, NOW(), NOW(), NULL, NULL)
ON CONFLICT (code) DO NOTHING;
