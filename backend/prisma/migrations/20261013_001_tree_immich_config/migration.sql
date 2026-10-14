-- Connexion Immich propre à chaque arbre : adresse de l'instance et clé d'API chiffrée.
-- Aucune ligne n'est créée pour les arbres existants : ils restent sans accès Immich
-- jusqu'à ce que leurs administrateurs configurent la connexion.
CREATE TABLE "tree_immich_configs" (
    "treeId" TEXT NOT NULL,
    "apiUrl" TEXT NOT NULL,
    "apiKeyEnc" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tree_immich_configs_pkey" PRIMARY KEY ("treeId")
);

ALTER TABLE "tree_immich_configs" ADD CONSTRAINT "tree_immich_configs_treeId_fkey"
  FOREIGN KEY ("treeId") REFERENCES "trees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
