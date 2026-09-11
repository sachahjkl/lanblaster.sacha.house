variable "image" {
  type        = string
  description = "Immutable GHCR image reference"

  validation {
    condition     = strlen(var.image) == 112 && substr(var.image, 0, 48) == "ghcr.io/sachahjkl/lanblaster.sacha.house@sha256:"
    error_message = "The image must use the Lanblaster GHCR repository and an exact SHA-256 digest."
  }
}

job "lanblaster-sacha-house" {
  namespace   = "staging"
  datacenters = ["homelab"]
  type        = "service"

  meta {
    image = var.image
  }

  group "web" {
    count = 1

    update {
      max_parallel      = 1
      health_check      = "checks"
      min_healthy_time  = "10s"
      healthy_deadline  = "2m"
      progress_deadline = "5m"
      auto_revert       = true
    }

    restart {
      attempts = 3
      interval = "10m"
      delay    = "15s"
      mode     = "fail"
    }

    reschedule {
      attempts       = 3
      interval       = "1h"
      delay          = "30s"
      delay_function = "exponential"
      max_delay      = "5m"
      unlimited      = false
    }

    network {
      mode = "host"

      port "http" {
        static       = 9031
        to           = 8000
        host_network = "loopback"
      }
    }

    task "web" {
      driver = "docker"

      config {
        image        = var.image
        network_mode = "services"
        ports        = ["http"]
      }

      service {
        name     = "lanblaster-sacha-house-staging"
        provider = "nomad"
        port     = "http"

        check {
          name     = "HTTP health"
          type     = "http"
          path     = "/health"
          interval = "10s"
          timeout  = "2s"

          check_restart {
            limit           = 3
            grace           = "30s"
            ignore_warnings = false
          }
        }
      }

      resources {
        cpu    = 200
        memory = 128
      }

      logs {
        max_files     = 5
        max_file_size = 10
      }

      kill_timeout = "15s"
    }
  }
}
