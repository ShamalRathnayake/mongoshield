{{/*
Shared template snippets: names and labels used by every resource in this chart.
Names are capped at 52 characters because the CronJob controller appends an
11-character suffix to Job names, and Kubernetes names max out at 63.
*/}}

{{/* The chart name, or nameOverride. */}}
{{- define "mongoshield.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 52 | trimSuffix "-" }}
{{- end }}

{{/*
The name for this release's resources: "<release>-mongoshield", or just
"<release>" when the release name already contains "mongoshield".
*/}}
{{- define "mongoshield.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 52 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 52 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 52 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Standard Kubernetes labels, on every resource. */}}
{{- define "mongoshield.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "mongoshield.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Labels that identify this release's pods. */}}
{{- define "mongoshield.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mongoshield.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* The ServiceAccount the pods run as. */}}
{{- define "mongoshield.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "mongoshield.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* The ConfigMap holding mongoshield.config.json (ours, or the user's own). */}}
{{- define "mongoshield.configMapName" -}}
{{- default (include "mongoshield.fullname" .) .Values.existingConfigMap }}
{{- end }}
