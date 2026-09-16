-- Table de référence pour les catégories de profil. Une table plutôt qu'un ENUM figé :
-- ajouter une catégorie plus tard = un INSERT, jamais une migration de type.
CREATE TABLE profile_types (
  code        TEXT PRIMARY KEY,
  label_fr    TEXT NOT NULL,
  label_en    TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INT NOT NULL DEFAULT 0
);

INSERT INTO profile_types (code, label_fr, label_en, sort_order) VALUES
  ('commercant',   'Commerçant',    'Merchant',        1),
  ('entrepreneur', 'Entrepreneur',  'Entrepreneur',    2),
  ('salarie',      'Salarié',       'Salaried worker',3),
  ('etudiant',     'Étudiant',      'Student',         4),
  ('autre',        'Autre',         'Other',           5);
