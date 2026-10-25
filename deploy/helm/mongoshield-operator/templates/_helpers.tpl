{{/*
Shared template snippets: names and labels used by every resource in this chart.
*/}}

{{/* The chart name, or nameOverride. */}}
{{- define "mongoshield-operator.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
The name for this release's resources: "<release>-mongoshield-operator", or just the
release name when it already contains the chart name.
*/}}
{{- define "mongoshield-operator.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Standard Kubernetes labels, on every resource. */}}
{{- define "mongoshield-operator.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "mongoshield-operator.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: mongoshield
{{- end }}

{{/* Labels that identify the operator's pods. */}}
{{- define "mongoshield-operator.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mongoshield-operator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* The ServiceAccount the operator runs as. */}}
{{- define "mongoshield-operator.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "mongoshield-operator.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* The image Jobs run: repository:tag. */}}
{{- define "mongoshield-operator.jobImage" -}}
{{- printf "%s:%s" .Values.jobImage.repository (.Values.jobImage.tag | default "latest") }}
{{- end }}
