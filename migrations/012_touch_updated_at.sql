-- Petite fonction utilitaire pour maintenir updated_at automatiquement.
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER user_profiles_touch_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER transaction_credentials_touch_updated_at
  BEFORE UPDATE ON transaction_credentials
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
