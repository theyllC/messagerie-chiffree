"""Génération de clés et signature du manifeste de mise à jour (Ed25519).

Usage :
  python tools/signer_release.py --generer
      Crée une paire de clés. Affiche la clé PUBLIQUE (à coller dans mise_a_jour.py)
      et la clé PRIVÉE (à stocker dans le secret GitHub UPDATE_SIGNING_KEY, jamais dans le dépôt).

  python tools/signer_release.py --exe dist/messagerie.exe --version 1.4.2 --depot compte/depot
      Calcule le SHA-256, signe et écrit version.json.
      La clé privée est lue dans la variable d'environnement UPDATE_SIGNING_KEY.
"""
import argparse
import base64
import hashlib
import json
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def generer() -> None:
    cle = Ed25519PrivateKey.generate()
    privee = cle.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    publique = cle.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    print("CLE_PUBLIQUE_B64 (à coller dans mise_a_jour.py) :")
    print(base64.b64encode(publique).decode())
    print()
    print("CLE PRIVEE (secret GitHub UPDATE_SIGNING_KEY, à ne jamais commiter) :")
    print(base64.b64encode(privee).decode())


def signer(exe: Path, version: str, depot: str, sortie: Path, notes: str) -> None:
    brute = os.environ.get("UPDATE_SIGNING_KEY")
    if not brute:
        sys.exit("Variable d'environnement UPDATE_SIGNING_KEY manquante.")
    cle = Ed25519PrivateKey.from_private_bytes(base64.b64decode(brute))

    sha256 = hashlib.sha256(exe.read_bytes()).hexdigest()
    url = f"https://github.com/{depot}/releases/download/v{version}/{exe.name}"
    message = f"{version}|{url}|{sha256}".encode()  # doit rester identique à _message_signe()
    signature = base64.b64encode(cle.sign(message)).decode()

    manifeste = {
        "version": version,
        "url": url,
        "sha256": sha256,
        "notes": notes,
        "signature": signature,
    }
    sortie.write_text(json.dumps(manifeste, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Manifeste écrit : {sortie}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--generer", action="store_true")
    p.add_argument("--exe", type=Path)
    p.add_argument("--version")
    p.add_argument("--depot")
    p.add_argument("--notes", default="")
    p.add_argument("--sortie", type=Path, default=Path("version.json"))
    a = p.parse_args()

    if a.generer:
        generer()
    elif a.exe and a.version and a.depot:
        signer(a.exe, a.version.lstrip("v"), a.depot, a.sortie, a.notes)
    else:
        p.error("Utilise --generer, ou --exe + --version + --depot.")
