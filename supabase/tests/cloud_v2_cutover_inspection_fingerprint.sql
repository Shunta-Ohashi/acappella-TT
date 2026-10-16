-- Read-only PostgreSQL 17 compatibility vector for the client-side
-- event_snapshot::text SHA-256 verifier. Run on a disposable test database.

begin;

do $$
declare
  payload constant jsonb := $json${
    "nested": {"longer": 0, "x": "tab\t"},
    "z": "雪😀",
    "a": [1, true, null, {"bb": 2, "c": "quote\"\\\n"}]
  }$json$::jsonb;
  expected_text constant text := $expected${"a": [1, true, null, {"c": "quote\"\\\n", "bb": 2}], "z": "雪😀", "nested": {"x": "tab\t", "longer": 0}}$expected$;
  expected_fingerprint constant text :=
    'edd018adc71fa0af7c3d41d4aa8813092b1e74ab0fe7398f598afad545008565';
begin
  if payload::text is distinct from expected_text then
    raise exception using
      errcode = '55000',
      message = 'PostgreSQL jsonb::text output does not match the inspection fingerprint vector';
  end if;

  if pg_catalog.encode(
    extensions.digest(payload::text, 'sha256'),
    'hex'
  ) is distinct from expected_fingerprint then
    raise exception using
      errcode = '55000',
      message = 'PostgreSQL jsonb SHA-256 does not match the inspection fingerprint vector';
  end if;
end;
$$;

rollback;
