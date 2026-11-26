# The POC is reached over IPv4 only, so there is no AAAA record. Docker publishes Caddy's ports to IPv6 through its
# userland proxy, so every IPv6 visitor would reach Caddy and the API from one address, and share their rate limits.
# The server keeps its IPv6 address and the security group its IPv6 rules: nothing points visitors there.
resource "aws_route53_record" "a" {
  zone_id = var.hosted_zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.server.public_ip]
}
