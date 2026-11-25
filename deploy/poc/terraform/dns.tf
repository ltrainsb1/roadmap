resource "aws_route53_record" "a" {
  zone_id = var.hosted_zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.server.public_ip]
}

resource "aws_route53_record" "aaaa" {
  zone_id = var.hosted_zone_id
  name    = var.domain
  type    = "AAAA"
  ttl     = 300
  records = aws_instance.server.ipv6_addresses
}
