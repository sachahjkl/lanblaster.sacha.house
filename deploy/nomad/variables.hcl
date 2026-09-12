variable "name" {
  type = string
}

variable "domain" {
  type = string
}

variable "environment" {
  type = string
}

variable "health_path" {
  type = string
}

variable "image" {
  type = string
}

variable "port" {
  type = number
}

variable "service_tags" {
  type = list(string)
}

variable "volume_enabled" {
  type = bool
}

variable "volume_mount_path" {
  type = string
}

variable "volume_name" {
  type = string
}
