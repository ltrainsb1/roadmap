# The version of each generated secret (see variable "secret_versions"). Terraform loads this file by itself.
# Raising a number writes a new random value for that secret only, so follow the rotation steps in
# deploy/poc/README.md first. A version only ever goes up: lowering one, or applying from a copy that lacks this
# file, counts as a change and writes a new value that no longer matches MongoDB (or breaks every unsubscribe link).
# totp-enc-key is not here and is never rotated.
secret_versions = {
  "mongo-root-password" = 1
  "mongo-app-password"  = 1
  "unsubscribe-key"     = 1
}
