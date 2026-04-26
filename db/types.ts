export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_type: string
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          metadata: Json
          venue_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type: string
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          metadata?: Json
          venue_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: string
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          metadata?: Json
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      engagement_events: {
        Row: {
          created_at: string
          data: Json
          event_type: string
          guest_id: string
          id: string
          mechanic_id: string | null
          resulted_in_message_id: string | null
          schema_version: number
          triggered_by_message_id: string | null
          triggered_by_transaction_id: string | null
          venue_id: string
        }
        Insert: {
          created_at?: string
          data?: Json
          event_type: string
          guest_id: string
          id?: string
          mechanic_id?: string | null
          resulted_in_message_id?: string | null
          schema_version?: number
          triggered_by_message_id?: string | null
          triggered_by_transaction_id?: string | null
          venue_id: string
        }
        Update: {
          created_at?: string
          data?: Json
          event_type?: string
          guest_id?: string
          id?: string
          mechanic_id?: string | null
          resulted_in_message_id?: string | null
          schema_version?: number
          triggered_by_message_id?: string | null
          triggered_by_transaction_id?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "engagement_events_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engagement_events_mechanic_id_fkey"
            columns: ["mechanic_id"]
            isOneToOne: false
            referencedRelation: "mechanics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engagement_events_resulted_in_message_id_fkey"
            columns: ["resulted_in_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engagement_events_triggered_by_message_id_fkey"
            columns: ["triggered_by_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engagement_events_triggered_by_transaction_id_fkey"
            columns: ["triggered_by_transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engagement_events_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      guest_states: {
        Row: {
          created_at: string
          entered_at: string
          exited_at: string | null
          guest_id: string
          id: string
          state: string
          triggered_by_event_id: string | null
          venue_id: string
        }
        Insert: {
          created_at?: string
          entered_at?: string
          exited_at?: string | null
          guest_id: string
          id?: string
          state: string
          triggered_by_event_id?: string | null
          venue_id: string
        }
        Update: {
          created_at?: string
          entered_at?: string
          exited_at?: string | null
          guest_id?: string
          id?: string
          state?: string
          triggered_by_event_id?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_states_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_states_triggered_by_event_id_fkey"
            columns: ["triggered_by_event_id"]
            isOneToOne: false
            referencedRelation: "engagement_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_states_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      guests: {
        Row: {
          created_at: string
          created_via: string
          email: string | null
          first_contacted_at: string | null
          first_name: string | null
          id: string
          last_inbound_at: string | null
          last_interaction_at: string | null
          last_name: string | null
          last_outbound_at: string | null
          last_visit_at: string | null
          opted_out_at: string | null
          phone_number: string
          status: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          created_at?: string
          created_via: string
          email?: string | null
          first_contacted_at?: string | null
          first_name?: string | null
          id?: string
          last_inbound_at?: string | null
          last_interaction_at?: string | null
          last_name?: string | null
          last_outbound_at?: string | null
          last_visit_at?: string | null
          opted_out_at?: string | null
          phone_number: string
          status?: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          created_at?: string
          created_via?: string
          email?: string | null
          first_contacted_at?: string | null
          first_name?: string | null
          id?: string
          last_inbound_at?: string | null
          last_interaction_at?: string | null
          last_name?: string | null
          last_outbound_at?: string | null
          last_visit_at?: string | null
          opted_out_at?: string | null
          phone_number?: string
          status?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "guests_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      mechanics: {
        Row: {
          created_at: string
          deactivated_at: string | null
          description: string | null
          expiration_rule: string | null
          id: string
          is_active: boolean
          metadata: Json
          name: string
          qualification: string | null
          redemption: Json | null
          reward_description: string | null
          schema_version: number
          trigger: Json
          type: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          created_at?: string
          deactivated_at?: string | null
          description?: string | null
          expiration_rule?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          qualification?: string | null
          redemption?: Json | null
          reward_description?: string | null
          schema_version?: number
          trigger: Json
          type: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          created_at?: string
          deactivated_at?: string | null
          description?: string | null
          expiration_rule?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          qualification?: string | null
          redemption?: Json | null
          reward_description?: string | null
          schema_version?: number
          trigger?: Json
          type?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mechanics_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          body: string
          category: string | null
          confidence_score: number | null
          created_at: string
          delivered_at: string | null
          direction: string
          edits_made: boolean
          failure_reason: string | null
          generated_by: string | null
          guest_id: string
          id: string
          media_urls: string[]
          parent_draft_id: string | null
          prompt_version: string | null
          provider_message_id: string | null
          reaction_type: string | null
          reply_to_message_id: string | null
          reviewed_at: string | null
          reviewed_by_operator_id: string | null
          sent_at: string | null
          status: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          body?: string
          category?: string | null
          confidence_score?: number | null
          created_at?: string
          delivered_at?: string | null
          direction: string
          edits_made?: boolean
          failure_reason?: string | null
          generated_by?: string | null
          guest_id: string
          id?: string
          media_urls?: string[]
          parent_draft_id?: string | null
          prompt_version?: string | null
          provider_message_id?: string | null
          reaction_type?: string | null
          reply_to_message_id?: string | null
          reviewed_at?: string | null
          reviewed_by_operator_id?: string | null
          sent_at?: string | null
          status?: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          body?: string
          category?: string | null
          confidence_score?: number | null
          created_at?: string
          delivered_at?: string | null
          direction?: string
          edits_made?: boolean
          failure_reason?: string | null
          generated_by?: string | null
          guest_id?: string
          id?: string
          media_urls?: string[]
          parent_draft_id?: string | null
          prompt_version?: string | null
          provider_message_id?: string | null
          reaction_type?: string | null
          reply_to_message_id?: string | null
          reviewed_at?: string | null
          reviewed_by_operator_id?: string | null
          sent_at?: string | null
          status?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_parent_draft_id_fkey"
            columns: ["parent_draft_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_reply_to_message_id_fkey"
            columns: ["reply_to_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_reviewed_by_operator_id_fkey"
            columns: ["reviewed_by_operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_venues: {
        Row: {
          created_at: string
          id: string
          operator_id: string
          permission_level: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          operator_id: string
          permission_level?: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          created_at?: string
          id?: string
          operator_id?: string
          permission_level?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_venues_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_venues_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      operators: {
        Row: {
          auth_user_id: string
          avatar_url: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          is_test: boolean
          job_title: string | null
          last_seen_at: string | null
          phone_number: string | null
          updated_at: string
        }
        Insert: {
          auth_user_id: string
          avatar_url?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id?: string
          is_test?: boolean
          job_title?: string | null
          last_seen_at?: string | null
          phone_number?: string | null
          updated_at?: string
        }
        Update: {
          auth_user_id?: string
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          is_test?: boolean
          job_title?: string | null
          last_seen_at?: string | null
          phone_number?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      transactions: {
        Row: {
          amount_cents: number
          created_at: string
          external_id: string | null
          guest_id: string | null
          id: string
          item_count: number | null
          match_confidence: number | null
          match_method: string | null
          matched_at: string | null
          occurred_at: string
          raw_data: Json | null
          source: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          external_id?: string | null
          guest_id?: string | null
          id?: string
          item_count?: number | null
          match_confidence?: number | null
          match_method?: string | null
          matched_at?: string | null
          occurred_at: string
          raw_data?: Json | null
          source: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          external_id?: string | null
          guest_id?: string | null
          id?: string
          item_count?: number | null
          match_confidence?: number | null
          match_method?: string | null
          matched_at?: string | null
          occurred_at?: string
          raw_data?: Json | null
          source?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transactions_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_configs: {
        Row: {
          approval_policy: Json
          brand_persona: Json
          created_at: string
          messaging_cadence: Json
          onboarding_status: string
          relationship_strength_formula: Json
          schema_version: number
          state_thresholds: Json
          updated_at: string
          venue_id: string
          venue_info: Json
        }
        Insert: {
          approval_policy?: Json
          brand_persona?: Json
          created_at?: string
          messaging_cadence?: Json
          onboarding_status?: string
          relationship_strength_formula?: Json
          schema_version?: number
          state_thresholds?: Json
          updated_at?: string
          venue_id: string
          venue_info?: Json
        }
        Update: {
          approval_policy?: Json
          brand_persona?: Json
          created_at?: string
          messaging_cadence?: Json
          onboarding_status?: string
          relationship_strength_formula?: Json
          schema_version?: number
          state_thresholds?: Json
          updated_at?: string
          venue_id?: string
          venue_info?: Json
        }
        Relationships: [
          {
            foreignKeyName: "venue_configs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venues: {
        Row: {
          created_at: string
          id: string
          is_test: boolean
          messaging_phone_number: string | null
          name: string
          slug: string
          status: string
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_test?: boolean
          messaging_phone_number?: string | null
          name: string
          slug: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_test?: boolean
          messaging_phone_number?: string | null
          name?: string
          slug?: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      voice_corpus: {
        Row: {
          confidence_score: number | null
          content: string
          created_at: string
          id: string
          is_processed: boolean
          language: string
          metadata: Json
          processed_at: string | null
          schema_version: number
          source_type: string
          tags: string[]
          updated_at: string
          venue_id: string
        }
        Insert: {
          confidence_score?: number | null
          content: string
          created_at?: string
          id?: string
          is_processed?: boolean
          language?: string
          metadata?: Json
          processed_at?: string | null
          schema_version?: number
          source_type: string
          tags?: string[]
          updated_at?: string
          venue_id: string
        }
        Update: {
          confidence_score?: number | null
          content?: string
          created_at?: string
          id?: string
          is_processed?: boolean
          language?: string
          metadata?: Json
          processed_at?: string | null
          schema_version?: number
          source_type?: string
          tags?: string[]
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_corpus_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_embeddings: {
        Row: {
          chunk_index: number
          chunk_text: string
          corpus_id: string
          created_at: string
          embedding: string | null
          embedding_model: string
          id: string
          metadata: Json
          venue_id: string
        }
        Insert: {
          chunk_index: number
          chunk_text: string
          corpus_id: string
          created_at?: string
          embedding?: string | null
          embedding_model: string
          id?: string
          metadata?: Json
          venue_id: string
        }
        Update: {
          chunk_index?: number
          chunk_text?: string
          corpus_id?: string
          created_at?: string
          embedding?: string | null
          embedding_model?: string
          id?: string
          metadata?: Json
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_embeddings_corpus_id_fkey"
            columns: ["corpus_id"]
            isOneToOne: false
            referencedRelation: "voice_corpus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_embeddings_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
