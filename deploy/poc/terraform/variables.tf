variable "region" {
  description = "The AWS region."
  type        = string
  default     = "us-east-1"
}

variable "domain" {
  description = "The host name the app is served on, for example roadmap.example.com."
  type        = string
}

variable "hosted_zone_id" {
  description = "An existing Route 53 hosted zone that holds the domain."
  type        = string
}

variable "github_repository" {
  description = "The GitHub repository allowed to deploy, as owner/name."
  type        = string
  default     = "ltrainsb1/roadmap"
}

variable "create_dmarc" {
  description = "Whether to create the DMARC record for the domain."
  type        = bool
  default     = true
}

variable "secret_versions" {
  description = <<-EOT
    The value_wo_version of each generated secret. Raising one entry writes a new value for that secret only.
    Raise a Mongo password only together with changing that user's password inside MongoDB, because SSM
    does not change it there. totp-enc-key is not in this map: it is never rotated, since every enrolled
    authenticator would stop working.
  EOT
  type        = map(number)
  default = {
    "mongo-root-password" = 1
    "mongo-app-password"  = 1
    "unsubscribe-key"     = 1
  }

  validation {
    condition = (
      toset(keys(var.secret_versions)) == toset(["mongo-root-password", "mongo-app-password", "unsubscribe-key"])
      && alltrue([for n in values(var.secret_versions) : n >= 1])
    )
    error_message = "secret_versions must have exactly mongo-root-password, mongo-app-password and unsubscribe-key, each 1 or more."
  }
}
