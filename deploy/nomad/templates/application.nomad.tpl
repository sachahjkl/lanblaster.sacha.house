[[ if eq (var "environment" .) "staging" ]]
job "lanblaster-sacha-house" {
  namespace   = [[ var "environment" . | quote ]]
  datacenters = ["homelab"]
  type        = "service"

  meta {
    image = [[ var "image" . | quote ]]
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
        to = 8000
      }
    }

    task "web" {
      driver = "docker"

      config {
        image        = [[ var "image" . | quote ]]
        network_mode = "services"
        ports        = ["http"]
      }

      service {
        name     = "lanblaster-sacha-house-staging"
        provider = "nomad"
        port     = "http"
        tags = [
          "traefik.enable=true",
          "traefik.http.routers.lanblaster-sacha-house-staging.entrypoints=websecure",
          "traefik.http.routers.lanblaster-sacha-house-staging.middlewares=lanblaster-sacha-house-staging-noindex",
          "traefik.http.routers.lanblaster-sacha-house-staging.rule=Host(`[[ var "domain" . ]]`)",
          "traefik.http.routers.lanblaster-sacha-house-staging.tls.domains[0].main=[[ var "domain" . ]]",
          "traefik.http.middlewares.lanblaster-sacha-house-staging-noindex.headers.customresponseheaders.X-Robots-Tag=noindex, nofollow",
        ]

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
[[ else ]]
job "lanblaster-sacha-house" {
  namespace   = [[ var "environment" . | quote ]]
  datacenters = ["homelab"]
  type        = "service"

  meta {
    image = [[ var "image" . | quote ]]
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
        to = 8000
      }
    }

    task "web" {
      driver = "docker"

      config {
        image        = [[ var "image" . | quote ]]
        network_mode = "services"
        ports        = ["http"]
      }

      service {
        name     = "lanblaster-sacha-house-production"
        provider = "nomad"
        port     = "http"
        tags = [
          "traefik.enable=true",
          "traefik.http.routers.lanblaster-sacha-house-production.entrypoints=websecure",
          "traefik.http.routers.lanblaster-sacha-house-production.rule=Host(`[[ var "domain" . ]]`)",
        ]

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
[[ end ]]
