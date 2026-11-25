plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.50.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

# github_repository is declared here for the OIDC file that Task 9 adds.
# Remove this rule's exemption once it is used.
rule "terraform_unused_declarations" {
  enabled = false
}
