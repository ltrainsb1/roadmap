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

variable "secret_version" {
  description = "The value_wo_version of every generated secret. Raising it writes new secrets."
  type        = number
  default     = 1
}
